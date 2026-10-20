//! Host-observed command outcome. Successful execution is narrower than task
//! completion; full logs remain authoritative for claims beyond this receipt.
const std = @import("std");
const record_json = @import("../shared/record_json.zig");
const evidence = @import("../agent/runtime/review_evidence.zig");

pub const Receipt = struct {
    version: []const u8 = "omos.command-receipt/v1",
    evidence_id: []const u8,
    action_id: ?[]const u8,
    source: ?[]const u8,
    state: []const u8,
    exit_code: i64,
    output_complete: bool,
    output_truncated: bool,
    outcome: enum { succeeded, failed },
    scope: []const u8 = "Process outcome only. Test coverage and external effects require their own evidence.",
    arguments: ?[]const u8 = null,
    arguments_sha256: ?[]const u8 = null,
};

pub fn derive(alloc: std.mem.Allocator, record: evidence.Evidence) !?Receipt {
    if (record.tool == null or (!std.mem.eql(u8, record.tool.?, "shell") and !std.mem.eql(u8, record.tool.?, "shell_input"))) return null;
    const Output = struct {
        state: []const u8,
        exit_code: ?i64 = null,
        output_incomplete: ?bool = null,
        output_truncated: bool = false,
        termination_indeterminate: bool = false,
        signal: ?i64 = null,
    };
    const output = record_json.decode(Output, alloc, record.content, .{ .ignore_unknown_fields = true }) catch return null;
    if (!std.mem.eql(u8, output.state, "completed") or output.termination_indeterminate or output.signal != null) return null;
    const exit_code = output.exit_code orelse return null;
    const arguments = if (record.arguments) |raw| try @import("../shared/text_utils.zig").maskSecrets(alloc, raw) else null;
    return .{
        .evidence_id = record.id,
        .action_id = record.action_id,
        .source = record.source,
        .state = output.state,
        .exit_code = exit_code,
        .output_complete = if (output.output_incomplete) |incomplete| !incomplete else false,
        .output_truncated = output.output_truncated,
        .outcome = if (exit_code == 0 and record.status == .success) .succeeded else .failed,
        .arguments = if (arguments) |value| if (value.len <= 2048) value else null else null,
        .arguments_sha256 = if (arguments) |value| try @import("fossil_workspace.zig").hash(alloc, value) else null,
    };
}

test "command receipts distinguish execution success from incomplete and unknown outcomes" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();
    var record: evidence.Evidence = .{ .id = "receipt", .tool = "shell", .status = .success, .content = "{\"state\":\"running\",\"exit_code\":null}" };
    try std.testing.expect(try derive(alloc, record) == null);
    record.content = "{\"state\":\"completed\",\"exit_code\":0,\"output_incomplete\":true}";
    const receipt = (try derive(alloc, record)).?;
    try std.testing.expectEqual(.succeeded, receipt.outcome);
    try std.testing.expect(!receipt.output_complete);
    record.content = "{\"state\":\"completed\",\"exit_code\":1}";
    try std.testing.expectEqual(.failed, (try derive(alloc, record)).?.outcome);
    record.content = "{\"state\":\"lost\",\"exit_code\":0,\"termination_indeterminate\":true}";
    try std.testing.expect(try derive(alloc, record) == null);
}
