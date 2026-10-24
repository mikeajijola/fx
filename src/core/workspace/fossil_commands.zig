const std = @import("std");
const workspace = @import("fossil_workspace.zig");

pub const Options = struct {
    action: enum { init, ensure, company, @"company-key", use, status, tasks, diff, history, verify, recover, migrate, definition, query, audit, serve, remote, @"export" } = .status,
    path: ?[]const u8 = null,
    definition_action: enum { show, validate, propose } = .show,
    execution_path: ?[]const u8 = null,
    offset: usize = 0,
    json: bool = false,
    writable: bool = false,
    request_path: ?[]const u8 = null,
    upgrade_contracts: bool = false,
};

pub fn parse(args: []const [:0]const u8) !Options {
    var options: Options = .{};
    var positional: usize = 0;
    var index: usize = 0;
    var offset_seen = false;
    while (index < args.len) : (index += 1) {
        const arg = args[index];
        if (std.mem.eql(u8, arg, "--json")) {
            options.json = true;
        } else if (std.mem.eql(u8, arg, "--write")) {
            if (options.writable) return error.UnexpectedArgument;
            options.writable = true;
        } else if (std.mem.eql(u8, arg, "--contracts")) {
            if (options.upgrade_contracts) return error.UnexpectedArgument;
            options.upgrade_contracts = true;
        } else if (std.mem.eql(u8, arg, "--offset")) {
            if (offset_seen) return error.UnexpectedArgument;
            offset_seen = true;
            index += 1;
            if (index >= args.len) return error.MissingOffset;
            options.offset = std.fmt.parseInt(usize, args[index], 10) catch return error.InvalidOffset;
        } else if (std.mem.eql(u8, arg, "--execution")) {
            index += 1;
            if (index >= args.len) return error.MissingPath;
            options.execution_path = args[index];
        } else if (std.mem.startsWith(u8, arg, "-")) {
            return error.UnknownFlag;
        } else if (positional == 0) {
            options.action = std.meta.stringToEnum(@TypeOf(options.action), arg) orelse return error.UnknownAction;
            positional += 1;
        } else if (options.action == .definition and positional == 1) {
            options.definition_action = std.meta.stringToEnum(@TypeOf(options.definition_action), arg) orelse return error.UnknownAction;
            positional += 1;
        } else if (options.path == null) {
            options.path = arg;
            positional += 1;
        } else if (options.action == .remote and options.request_path == null) {
            options.request_path = arg;
        } else return error.UnexpectedArgument;
    }
    switch (options.action) {
        .use, .@"export", .remote => if (options.path == null) return error.MissingPath,
        .definition => switch (options.definition_action) {
            .show => if (options.path != null) return error.UnexpectedArgument,
            .validate, .propose => if (options.path == null) return error.MissingPath,
        },
        .company, .@"company-key" => if (options.path == null) return error.MissingPath,
        .init, .diff, .query, .serve => {},
        else => if (options.path != null) return error.UnexpectedArgument,
    }
    if (offset_seen and options.action != .query) return error.UnexpectedArgument;
    if (options.writable and options.action != .serve) return error.UnexpectedArgument;
    if (options.upgrade_contracts and options.action != .migrate) return error.UnexpectedArgument;
    if (options.action == .serve and options.path != null) _ = std.fmt.parseInt(u16, options.path.?, 10) catch return error.InvalidPort;
    if (options.execution_path != null and !(options.action == .definition and options.definition_action == .propose)) return error.UnexpectedArgument;
    return options;
}

pub const Reply = union(enum) { workspace: workspace.Snapshot, identity: @import("company_identity.zig").Snapshot };

pub fn execute(alloc: std.mem.Allocator, options: Options) !Reply {
    if (options.action == .@"company-key") {
        const model = @import("definition.zig");
        const declaration = try model.parse(alloc, model.seed);
        const input = try std.json.parseFromSliceLeaky(std.json.Value, alloc, try std.json.Stringify.valueAlloc(alloc, .{ .key_handle = options.path.? }, .{}), .{});
        try model.validateOperation(alloc, declaration, "omos_create_company_key", input, .input);
        const identity = try @import("company_identity.zig").create(alloc, options.path.?);
        const retained_key = try @import("company_identity.zig").load(alloc, options.path.?);
        const retained_public = std.fmt.bytesToHex(retained_key.public_key.toBytes(), .lower);
        if (!std.mem.eql(u8, identity.public_key, &retained_public)) return error.CompanyKeyChanged;
        const output = try std.json.parseFromSliceLeaky(std.json.Value, alloc, try std.json.Stringify.valueAlloc(alloc, identity, .{}), .{});
        try model.validateOperation(alloc, declaration, "omos_create_company_key", output, .output);
        return .{ .identity = identity };
    }
    if (options.action == .remote) {
        const data = try @import("workspace_client.zig").call(alloc, options.path.?, if (options.request_path) |path| try readDefinition(alloc, path) else null);
        const model = @import("definition.zig");
        const context = if (model.field(data, "payload")) |payload| if (payload == .string) try std.json.parseFromSliceLeaky(std.json.Value, alloc, payload.string, .{}) else data else data;
        return .{ .workspace = .{ .repository = options.path.?, .workspace_id = model.text(context, "workspace"), .trunk_revision = model.text(data, "revision"), .tasks = &.{}, .pending_journals = 0, .publication = "remote", .model_data = data } };
    }
    const manager = switch (options.action) {
        .init => try workspace.Manager.init(alloc, options.path orelse "omos.fossil"),
        .ensure => try workspace.Manager.ensureBound(alloc),
        .use => try workspace.Manager.open(alloc, options.path.?),
        else => (try workspace.Manager.bound(alloc)) orelse return error.NoFossilWorkspace,
    };
    var detail: []const u8 = "";
    var model_data: ?std.json.Value = null;
    switch (options.action) {
        .company => model_data = (try std.json.parseFromSlice(std.json.Value, alloc, try @import("company_service.zig").administer(manager, try readDefinition(alloc, options.path.?)), .{})).value,
        .ensure => detail = "Personal instance initialized or existing workspace retained.",
        .init => {
            try manager.use();
            const result = try manager.importHistory();
            detail = try alloc.print("Initialized workspace; archived {d} existing sessions and skipped {d} unreadable archives. Original sessions are retained.", .{ result.imported, result.skipped });
        },
        .use => {
            try manager.use();
            detail = "Workspace binding saved in your profile.";
        },
        .verify => {
            try manager.verify();
            detail = "Fossil repository integrity and workspace identity verified.";
        },
        .recover => {
            try manager.recover();
            detail = "Recovered pending evidence and publication receipts.";
        },
        .@"export" => {
            try manager.exportRepository(options.path.?);
            detail = try alloc.print("Verified portable workspace exported to {s}.", .{options.path.?});
        },
        .history => detail = try manager.history(),
        .diff => {
            const all = try manager.tasks();
            const task = if (options.path) |id| try manager.loadTask(id) else if (all.len == 1) all[0] else return error.TaskIdRequired;
            detail = try manager.diff(task);
        },
        .migrate => detail = if (options.upgrade_contracts) try manager.upgradeContracts() else try manager.migrate(),
        .definition => switch (options.definition_action) {
            .show => model_data = try manager.definitionSnapshot(null),
            .validate => {
                const report = try @import("definition.zig").validate(alloc, try readDefinition(alloc, options.path.?));
                model_data = (try std.json.parseFromSlice(std.json.Value, alloc, try std.json.Stringify.valueAlloc(alloc, report, .{}), .{})).value;
            },
            .propose => model_data = (try std.json.parseFromSlice(std.json.Value, alloc, try manager.proposeDefinition(null, try readDefinition(alloc, options.path.?), if (options.execution_path) |path| try readDefinition(alloc, path) else null), .{})).value,
        },
        .query => model_data = (try std.json.parseFromSlice(std.json.Value, alloc, try manager.queryRecords(null, options.path, options.offset), .{})).value,
        .audit => model_data = (try std.json.parseFromSlice(std.json.Value, alloc, try manager.auditContracts(), .{})).value,
        .serve => return error.ServiceRequiresCliHost,
        .remote, .@"company-key" => unreachable,
        .status, .tasks => {},
    }
    var snapshot = try manager.snapshot(detail);
    snapshot.model_data = model_data;
    return .{ .workspace = snapshot };
}

pub fn taskCommand(alloc: std.mem.Allocator, session: []const u8, project: []const u8, rest: []const u8) ![]const u8 {
    const manager = (try workspace.Manager.bound(alloc)) orelse return error.NoFossilWorkspace;
    const text = std.mem.trim(u8, rest, " \t");
    const split = std.mem.findScalar(u8, text, ' ') orelse text.len;
    const action = text[0..split];
    const argument = std.mem.trim(u8, text[split..], " \t");
    const task = if (std.mem.eql(u8, action, "new"))
        try manager.start(session, project, argument, null)
    else if (std.mem.eql(u8, action, "resume"))
        try manager.resumeTask(session, argument, project)
    else
        return error.InvalidTaskCommand;
    return alloc.print("Task {s}\nBranch: {s}\nState: {s}\nGoal: {s}", .{ task.id, task.branch, @tagName(task.state), task.definition.objective });
}

fn readDefinition(alloc: std.mem.Allocator, path: []const u8) ![]const u8 {
    var file = try std.Io.Dir.cwd().openFile(@import("../shared/io.zig").getIo(), path, .{ .allow_directory = false, .follow_symlinks = false });
    defer file.close(@import("../shared/io.zig").getIo());
    return @import("../shared/io.zig").readFileToEnd(alloc, &file, 1_000_000);
}

test "fossil command query pagination validates offsets" {
    try std.testing.expectEqual(@as(usize, 32), (try parse(&.{ "query", "omos_task", "--offset", "32" })).offset);
    try std.testing.expectError(error.InvalidOffset, parse(&.{ "query", "--offset", "-1" }));
    try std.testing.expectError(error.MissingOffset, parse(&.{ "query", "--offset" }));
    try std.testing.expectError(error.UnexpectedArgument, parse(&.{ "status", "--offset", "0" }));
    try std.testing.expectError(error.UnexpectedArgument, parse(&.{ "query", "--offset", "0", "--offset", "1" }));
}
