const std = @import("std");
const workspace = @import("../../core/workspace/fossil_workspace.zig");
const dispatch = @import("../../core/tooling/tool_dispatch.zig");

const Input = struct {
    action: enum { status, read, write, artifact, diff, history, verify_manifest, definition, query, record, propose_definition },
    path: ?[]const u8 = null,
    content: ?[]const u8 = null,
    entity: ?[]const u8 = null,
    offset: usize = 0,
    execution: ?[]const u8 = null,
};
const Parsed = std.json.Parsed(Input);

fn destroy(ptr: *anyopaque, alloc: std.mem.Allocator) void {
    const parsed: *Parsed = @ptrCast(@alignCast(ptr));
    parsed.deinit();
    alloc.destroy(parsed);
}

pub fn decode(ctx: dispatch.DispatchContext, args: []const u8) dispatch.DispatchError!dispatch.DecodeResult {
    const parsed = try ctx.allocator.create(Parsed);
    errdefer ctx.allocator.destroy(parsed);
    parsed.* = std.json.parseFromSlice(Input, ctx.allocator, args, .{ .allocate = .alloc_always }) catch |err| {
        if (err == error.OutOfMemory) return err;
        const failure = try ctx.allocator.dupe(u8, "Invalid fossil_workspace arguments");
        ctx.allocator.destroy(parsed);
        return .{ .failure = failure };
    };
    return .{ .input = .{ .ptr = parsed, .deinit_fn = destroy } };
}

pub fn readsOnly(input: dispatch.ToolInput) bool {
    return switch (input.as(Parsed).value.action) {
        .write, .artifact, .record, .propose_definition => false,
        else => true,
    };
}

pub fn irreversible(_: dispatch.ToolInput) bool {
    return false;
}

pub fn call(ctx: dispatch.DispatchContext, input: dispatch.ToolInput) dispatch.DispatchError!dispatch.ToolResult {
    if (comptime @import("builtin").target.cpu.arch.isWasm()) return .{ .failure = try ctx.allocator.dupe(u8, "Fossil is available only in the native CLI host.") };
    var arena = std.heap.ArenaAllocator.init(ctx.allocator);
    defer arena.deinit();
    const result = execute(arena.allocator(), ctx, input.as(Parsed).value) catch |err| {
        return .{ .failure = try ctx.allocator.print("Fossil workspace: {s}. The task remains unaccepted.", .{@errorName(err)}) };
    };
    return .{ .success = try ctx.allocator.dupe(u8, result) };
}

fn execute(alloc: std.mem.Allocator, ctx: dispatch.DispatchContext, input: Input) ![]const u8 {
    if (!ctx.fossil_workspace_available) return error.UnmanagedHost;
    const manager = (try workspace.Manager.bound(alloc)) orelse return error.NoFossilWorkspace;
    const task = if (ctx.fossil_session_id) |session| try manager.active(session) else null;
    if (input.action == .status) {
        var snapshot = try manager.snapshot("");
        if (task) |active| snapshot.files = try manager.inventory(active.branch);
        return std.json.Stringify.valueAlloc(alloc, snapshot, .{});
    }
    if (input.action == .history) return manager.history();
    if (input.action == .definition) return std.json.Stringify.valueAlloc(alloc, try manager.definitionSnapshot(task), .{});
    if (input.action == .query) return manager.queryRecords(task, input.entity, input.offset);
    if (input.action == .read) {
        const path = input.path orelse return error.MissingPath;
        return if (task) |active| manager.readContent(active, path) else manager.trunkContent(path);
    }
    const active = task orelse return error.SavedTaskRequired;
    switch (input.action) {
        .propose_definition => return manager.proposeDefinition(active, input.content orelse return error.MissingContent, input.execution),
        .record => return manager.writeRecord(active, input.entity orelse return error.MissingEntityType, input.content orelse return error.MissingContent),
        .verify_manifest => return manager.verifyManifest(active, input.path orelse return error.MissingPath),
        .diff => return manager.diff(active),
        .write => {
            try manager.writeContent(active, input.path orelse return error.MissingPath, input.content orelse return error.MissingContent);
            return "Workspace content checkpointed on the task branch.";
        },
        .artifact => return manager.artifact(active, input.content orelse return error.MissingContent),
        else => unreachable,
    }
}
