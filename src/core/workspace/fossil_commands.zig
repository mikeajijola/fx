const std = @import("std");
const workspace = @import("fossil_workspace.zig");

pub const Options = struct {
    action: enum { init, use, status, tasks, diff, history, verify, recover, migrate, definition, query, @"export" } = .status,
    path: ?[]const u8 = null,
    definition_action: enum { show, validate, propose } = .show,
    execution_path: ?[]const u8 = null,
    json: bool = false,
};

pub fn parse(args: []const [:0]const u8) !Options {
    var options: Options = .{};
    var positional: usize = 0;
    var index: usize = 0;
    while (index < args.len) : (index += 1) {
        const arg = args[index];
        if (std.mem.eql(u8, arg, "--json")) {
            options.json = true;
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
        } else return error.UnexpectedArgument;
    }
    switch (options.action) {
        .use, .@"export" => if (options.path == null) return error.MissingPath,
        .definition => switch (options.definition_action) {
            .show => if (options.path != null) return error.UnexpectedArgument,
            .validate, .propose => if (options.path == null) return error.MissingPath,
        },
        .init, .diff, .query => {},
        else => if (options.path != null) return error.UnexpectedArgument,
    }
    if (options.execution_path != null and !(options.action == .definition and options.definition_action == .propose)) return error.UnexpectedArgument;
    return options;
}

pub fn execute(alloc: std.mem.Allocator, options: Options) !workspace.Snapshot {
    const manager = switch (options.action) {
        .init => try workspace.Manager.init(alloc, options.path orelse "omos.fossil"),
        .use => try workspace.Manager.open(alloc, options.path.?),
        else => (try workspace.Manager.bound(alloc)) orelse return error.NoFossilWorkspace,
    };
    var detail: []const u8 = "";
    var model_data: ?std.json.Value = null;
    switch (options.action) {
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
        .migrate => detail = try manager.migrate(),
        .definition => switch (options.definition_action) {
            .show => model_data = try manager.definitionSnapshot(null),
            .validate => {
                const report = try @import("definition.zig").validate(alloc, try readDefinition(alloc, options.path.?));
                model_data = (try std.json.parseFromSlice(std.json.Value, alloc, try std.json.Stringify.valueAlloc(alloc, report, .{}), .{})).value;
            },
            .propose => model_data = (try std.json.parseFromSlice(std.json.Value, alloc, try manager.proposeDefinition(null, try readDefinition(alloc, options.path.?), if (options.execution_path) |path| try readDefinition(alloc, path) else null), .{})).value,
        },
        .query => model_data = (try std.json.parseFromSlice(std.json.Value, alloc, try manager.queryRecords(null, options.path, 0), .{})).value,
        .status, .tasks => {},
    }
    var snapshot = try manager.snapshot(detail);
    snapshot.model_data = model_data;
    return snapshot;
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
