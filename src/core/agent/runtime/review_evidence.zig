//! Bounded views of retained evidence. A preview is never proof of unseen bytes.
const std = @import("std");
const types = @import("../../shared/types.zig");

pub const Evidence = struct {
    id: []const u8,
    kind: enum { tool, candidate, workspace, context, verification } = .tool,
    tool: ?[]const u8 = null,
    arguments: ?[]const u8 = null,
    status: ?types.PersistedToolStatus = null,
    content: []const u8,
};

pub const IndexEntry = struct {
    id: []const u8,
    kind: @FieldType(Evidence, "kind"),
    tool: ?[]const u8,
    arguments: ?[]const u8,
    status: ?types.PersistedToolStatus,
    bytes: usize,
    sha256: []const u8,
    content: []const u8,
    complete: bool,
};

pub const View = struct {
    records: []const Evidence,
    inspected: []usize,
    payloads: []const []const u8,

    pub fn init(alloc: std.mem.Allocator, records: []const Evidence) !View {
        const inspected = try alloc.alloc(usize, records.len);
        @memset(inspected, 0);
        const payloads = try alloc.alloc([]const u8, records.len);
        for (records, payloads) |record, *payload| payload.* = try std.json.Stringify.valueAlloc(alloc, .{ .arguments = record.arguments, .content = record.content }, .{});
        return .{ .records = records, .inspected = inspected, .payloads = payloads };
    }

    pub fn prefix(bytes: []const u8, limit: usize) []const u8 {
        var end = @min(bytes.len, limit);
        while (end > 0 and !std.unicode.utf8ValidateSlice(bytes[0..end])) end -= 1;
        return bytes[0..end];
    }

    pub fn index(self: *View, alloc: std.mem.Allocator, offset: usize, limit: usize) ![]const IndexEntry {
        const start = @min(offset, self.records.len);
        const end = start + @min(@min(limit, 128), self.records.len - start);
        const result = try alloc.alloc(IndexEntry, end - start);
        for (self.records[start..end], result, start..) |record, *entry, ordinal| {
            const payload = self.payloads[ordinal];
            var digest: [32]u8 = undefined;
            std.crypto.hash.sha2.Sha256.hash(payload, &digest, .{});
            const complete = payload.len <= 2048;
            const content = if (complete) record.content else prefix(record.content, 256);
            if (complete) self.inspected[ordinal] = payload.len;
            entry.* = .{
                .id = record.id,
                .kind = record.kind,
                .tool = record.tool,
                .arguments = if (record.arguments) |args| if (complete) args else prefix(args, 512) else null,
                .status = record.status,
                .bytes = payload.len,
                .sha256 = try alloc.dupe(u8, &std.fmt.bytesToHex(&digest, .lower)),
                .content = content,
                .complete = complete,
            };
        }
        return result;
    }

    pub fn page(self: *View, alloc: std.mem.Allocator, raw: []const u8) ![]const u8 {
        const Command = struct { action: enum { list, read }, id: ?[]const u8 = null, offset: usize = 0, limit: usize = 16384 };
        const parsed = try std.json.parseFromSlice(Command, alloc, raw, .{});
        defer parsed.deinit();
        const command = parsed.value;
        if (command.limit == 0) return error.InvalidEvidenceOffset;
        if (command.action == .list) {
            const entries = try self.index(alloc, command.offset, @min(command.limit, 32));
            return std.json.Stringify.valueAlloc(alloc, .{
                .evidence = entries,
                .total = self.records.len,
                .nextOffset = if (command.offset < self.records.len and entries.len < self.records.len - command.offset) command.offset + entries.len else @as(?usize, null),
            }, .{});
        }
        const id = command.id orelse return error.InvalidContractEvidence;
        for (self.records, 0..) |record, ordinal| {
            if (!std.mem.eql(u8, record.id, id)) continue;
            const payload = self.payloads[ordinal];
            if (command.offset > payload.len or (command.offset < payload.len and (payload[command.offset] & 0xc0) == 0x80)) return error.InvalidEvidenceOffset;
            const chunk = prefix(payload[command.offset..], @min(command.limit, 16384));
            if (command.offset <= self.inspected[ordinal]) self.inspected[ordinal] = @max(self.inspected[ordinal], command.offset + chunk.len);
            return std.json.Stringify.valueAlloc(alloc, .{
                .id = id,
                .offset = command.offset,
                .content = chunk,
                .bytes = payload.len,
                .nextOffset = if (command.offset + chunk.len < payload.len) command.offset + chunk.len else @as(?usize, null),
                .fullyInspected = self.inspected[ordinal] == payload.len,
            }, .{});
        }
        return error.InvalidContractEvidence;
    }

    pub fn requireInspected(self: View, id: []const u8) !void {
        for (self.records, 0..) |record, i| {
            if (!std.mem.eql(u8, record.id, id)) continue;
            if (self.inspected[i] != self.payloads[i].len) return error.UninspectedContractEvidence;
            return;
        }
        return error.InvalidContractEvidence;
    }
};

test "completion review pages require contiguous inspection and preserve UTF-8" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();
    const content = try alloc.alloc(u8, 40000);
    @memset(content, 'x');
    var view = try View.init(alloc, &.{.{ .id = "tool:large", .content = content }});
    _ = try view.index(alloc, 0, 128);
    try std.testing.expectError(error.UninspectedContractEvidence, view.requireInspected("tool:large"));
    _ = try view.page(alloc, "{\"action\":\"read\",\"id\":\"tool:large\",\"offset\":30000}");
    try std.testing.expectError(error.UninspectedContractEvidence, view.requireInspected("tool:large"));
    var offset: usize = 0;
    while (offset < content.len) : (offset += 16384) {
        _ = try view.page(alloc, try std.json.Stringify.valueAlloc(alloc, .{ .action = "read", .id = "tool:large", .offset = offset }, .{}));
    }
    try view.requireInspected("tool:large");
    try std.testing.expectEqualStrings("", View.prefix("£", 1));
}
