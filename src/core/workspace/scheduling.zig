//! Portable schedules reference work contracts. Task evidence and publication
//! remain owned by the native task runtime.
const std = @import("std");

pub const State = enum { scheduled, overdue, running, waiting, failed, cancelled, completed };
pub const Event = struct {
    at_ms: i64,
    kind: []const u8,
    scheduled_ms: i64,
    contract_version: u32,
    reason: []const u8 = "",
};
pub const Schedule = struct {
    id: []const u8,
    task: []const u8,
    at_ms: i64,
    state: State = .scheduled,
    contract_version: u32,
    generation: u64 = 0,
    owner: []const u8 = "",
    lease_expires_ms: i64 = 0,
    started_ms: ?i64 = null,
    finished_ms: ?i64 = null,
    reason: []const u8 = "",
    history: []const Event = &.{},
};
pub const Store = struct {
    version: []const u8 = "omos.schedule/v1",
    workspace: []const u8,
    schedules: []const Schedule = &.{},
};
pub const Entry = struct {
    id: []const u8,
    task: []const u8,
    at_ms: i64,
    state: State,
    contract_version: u32,
    execution_contract_version: u32,
    objective: []const u8,
    task_state: []const u8,
    started_ms: ?i64,
    finished_ms: ?i64,
    reason: []const u8,
    history: []const Event,
    definition: @import("../agent/runtime/work_contract.zig").Definition,
    amendments: []const []const u8,
    branch: []const u8,
};
pub const Snapshot = struct {
    version: []const u8 = "omos.schedule/v1",
    workspace: []const u8,
    revision: []const u8,
    schedules: []const Entry,
};
pub const Request = struct {
    action: enum { list, show, add, move, cancel } = .list,
    task: ?[]const u8 = null,
    id: ?[]const u8 = null,
    at: ?[]const u8 = null,
    from: ?[]const u8 = null,
    to: ?[]const u8 = null,
    revision: ?[]const u8 = null,
};
pub const Options = struct { request: Request = .{}, json: bool = false };

pub fn parseArgs(args: []const [:0]const u8) !Options {
    var options: Options = .{};
    var index: usize = 0;
    if (args.len > 0 and !std.mem.startsWith(u8, args[0], "--")) {
        options.request.action = std.meta.stringToEnum(@FieldType(Request, "action"), args[0]) orelse return error.InvalidScheduleAction;
        index += 1;
    }
    if (options.request.action != .list) {
        if (index == args.len or std.mem.startsWith(u8, args[index], "--")) return error.ScheduleIdRequired;
        if (options.request.action == .add) options.request.task = args[index] else options.request.id = args[index];
        index += 1;
    }
    while (index < args.len) : (index += 1) {
        const arg = args[index];
        if (std.mem.eql(u8, arg, "--json")) {
            options.json = true;
            continue;
        }
        if (index + 1 == args.len) return error.MissingScheduleOptionValue;
        const next = args[index + 1];
        if (std.mem.eql(u8, arg, "--at") and options.request.at == null) options.request.at = next else if (std.mem.eql(u8, arg, "--from") and options.request.from == null) options.request.from = next else if (std.mem.eql(u8, arg, "--to") and options.request.to == null) options.request.to = next else if (std.mem.eql(u8, arg, "--revision") and options.request.revision == null) options.request.revision = next else return error.InvalidScheduleOption;
        index += 1;
    }
    try validate(options.request);
    return options;
}

pub fn validate(request: Request) !void {
    if (request.action == .add or request.action == .move) {
        _ = try parseTimestamp(request.at orelse return error.ScheduleTimeRequired);
    } else if (request.at != null) return error.InvalidScheduleOption;
    if (request.action == .add) {
        if (request.task == null or request.id != null) return error.TaskIdRequired;
    } else if (request.task != null) return error.InvalidScheduleOption;
    if (request.action != .list and request.action != .add and request.id == null) return error.ScheduleIdRequired;
    if (request.action == .list and request.id != null) return error.InvalidScheduleOption;
    if (request.action != .list and (request.from != null or request.to != null)) return error.InvalidScheduleOption;
    const from = if (request.from) |raw| try parseTimestamp(raw) else std.math.minInt(i64);
    const to = if (request.to) |raw| try parseTimestamp(raw) else std.math.maxInt(i64);
    if (from >= to) return error.InvalidScheduleRange;
}

fn number(raw: []const u8) !i64 {
    for (raw) |c| if (!std.ascii.isDigit(c)) return error.InvalidScheduleTime;
    return std.fmt.parseInt(i64, raw, 10) catch error.InvalidScheduleTime;
}

/// RFC 3339 with seconds and an explicit offset; optional millisecond precision.
pub fn parseTimestamp(raw: []const u8) !i64 {
    if (raw.len < 20 or raw.len > 29) return error.InvalidScheduleTime;
    if (raw[4] != '-' or raw[7] != '-' or raw[10] != 'T' or raw[13] != ':' or raw[16] != ':') return error.InvalidScheduleTime;
    const year = try number(raw[0..4]);
    const month = try number(raw[5..7]);
    const day = try number(raw[8..10]);
    const hour = try number(raw[11..13]);
    const minute = try number(raw[14..16]);
    const second = try number(raw[17..19]);
    if (year < 1970 or year > 9999 or month < 1 or month > 12 or hour > 23 or minute > 59 or second > 59) return error.InvalidScheduleTime;
    const leap = @mod(year, 4) == 0 and (@mod(year, 100) != 0 or @mod(year, 400) == 0);
    const month_days = [_]i64{ 31, if (leap) 29 else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 };
    if (day < 1 or day > month_days[@intCast(month - 1)]) return error.InvalidScheduleTime;
    var days: i64 = 365 * (year - 1970) + @divFloor(year - 1, 4) - @divFloor(1969, 4) - @divFloor(year - 1, 100) + @divFloor(1969, 100) + @divFloor(year - 1, 400) - @divFloor(1969, 400);
    for (month_days[0..@intCast(month - 1)]) |count| days += count;
    days += day - 1;
    var pos: usize = 19;
    var millis: i64 = 0;
    if (raw[pos] == '.') {
        pos += 1;
        const start = pos;
        while (pos < raw.len and std.ascii.isDigit(raw[pos])) : (pos += 1) {}
        const digits = pos - start;
        if (digits == 0 or digits > 3) return error.InvalidScheduleTime;
        millis = try number(raw[start..pos]);
        for (digits..3) |_| millis *= 10;
    }
    if (pos == raw.len) return error.ScheduleOffsetRequired;
    var offset: i64 = 0;
    if (raw[pos] == 'Z' and pos + 1 == raw.len) {} else if ((raw[pos] == '+' or raw[pos] == '-') and pos + 6 == raw.len and raw[pos + 3] == ':') {
        const hours = try number(raw[pos + 1 .. pos + 3]);
        const minutes = try number(raw[pos + 4 .. pos + 6]);
        if (hours > 23 or minutes > 59 or (raw[pos] == '-' and hours == 0 and minutes == 0)) return error.InvalidScheduleTime;
        offset = (hours * 60 + minutes) * 60 * (if (raw[pos] == '+') @as(i64, 1) else -1);
    } else return error.ScheduleOffsetRequired;
    const timestamp = ((days * 24 + hour) * 3600 + minute * 60 + second - offset) * 1000 + millis;
    // Validate the normalized UTC instant as well as the local calendar date.
    // The final supported instant is 9999-12-31T23:59:59.999Z.
    if (timestamp < 0 or timestamp > 253_402_300_799_999) return error.InvalidScheduleTime;
    return timestamp;
}

pub fn requireAvailableTask(schedules: []const Schedule, task: []const u8, selected_id: ?[]const u8) !void {
    for (schedules) |existing| {
        if (selected_id) |id| if (std.mem.eql(u8, existing.id, id)) continue;
        if (std.mem.eql(u8, existing.task, task) and existing.state != .cancelled and existing.state != .completed and existing.state != .failed) return error.TaskAlreadyScheduled;
    }
}

pub fn owns(schedule: Schedule, previous: Schedule) bool {
    return schedule.state == .running and schedule.generation == previous.generation and std.mem.eql(u8, schedule.owner, previous.owner);
}

pub fn validOwner(owner: []const u8) bool {
    if (owner.len != 64) return false;
    for (owner) |ch| if (!std.ascii.isHex(ch)) return false;
    return true;
}

test "schedule timestamps normalize explicit offsets and reject invalid calendar dates" {
    try std.testing.expectEqual(@as(i64, 0), try parseTimestamp("1970-01-01T00:00:00Z"));
    try std.testing.expectEqual(try parseTimestamp("2026-10-23T08:00:00Z"), try parseTimestamp("2026-10-23T09:00:00+01:00"));
    try std.testing.expectEqual(@as(i64, 123), try parseTimestamp("1970-01-01T00:00:00.123Z"));
    _ = try parseTimestamp("2000-02-29T00:00:00Z");
    for ([_][]const u8{ "2026-02-29T09:00:00Z", "2100-02-29T09:00:00Z", "2026-13-01T00:00:00Z", "2026-10-23T24:00:00Z", "2026-10-23T09:00:00-00:00" }) |raw| try std.testing.expectError(error.InvalidScheduleTime, parseTimestamp(raw));
    try std.testing.expectError(error.ScheduleOffsetRequired, parseTimestamp("2026-10-23T09:00:00.0"));
}

test "schedule command requires time for mutations and fences ownership" {
    try std.testing.expectError(error.ScheduleTimeRequired, parseArgs(&.{ "add", "task" }));
    try std.testing.expectError(error.InvalidScheduleOption, parseArgs(&.{ "cancel", "schedule", "--at", "2026-10-23T09:00:00Z" }));
    const opts = try parseArgs(&.{ "add", "task", "--at", "2026-10-23T09:00:00Z", "--json" });
    try std.testing.expect(opts.json);
    const current: Schedule = .{ .id = "s", .task = "t", .at_ms = 0, .contract_version = 1, .state = .running, .generation = 2, .owner = "worker" };
    var stale = current;
    stale.generation = 1;
    try std.testing.expect(!owns(current, stale));
    try std.testing.expect(owns(current, current));
}

test "schedule timestamps reject offsets outside the supported UTC range" {
    try std.testing.expectEqual(@as(i64, 0), try parseTimestamp("1970-01-01T01:00:00+01:00"));
    try std.testing.expectEqual(@as(i64, 253_402_300_799_999), try parseTimestamp("9999-12-31T22:59:59.999-01:00"));
    for ([_][]const u8{ "1970-01-01T00:00:00+01:00", "1970-01-01T00:59:59.999+01:00", "9999-12-31T23:00:00-01:00", "9999-12-31T23:59:59.999-01:00" }) |raw|
        try std.testing.expectError(error.InvalidScheduleTime, parseTimestamp(raw));
}

test "schedule moves cannot duplicate a replacement for a failed start" {
    const failed: Schedule = .{ .id = "old", .task = "task", .at_ms = 0, .contract_version = 1, .state = .failed };
    var replacement: Schedule = .{ .id = "new", .task = "task", .at_ms = 1, .contract_version = 1 };
    try requireAvailableTask(&.{failed}, "task", null);
    for ([_]State{ .scheduled, .overdue, .running, .waiting }) |state| {
        replacement.state = state;
        try std.testing.expectError(error.TaskAlreadyScheduled, requireAvailableTask(&.{ failed, replacement }, "task", failed.id));
        try requireAvailableTask(&.{replacement}, "task", replacement.id);
    }
    for ([_]State{ .cancelled, .completed, .failed }) |state| {
        replacement.state = state;
        try requireAvailableTask(&.{ failed, replacement }, "task", failed.id);
    }
}
