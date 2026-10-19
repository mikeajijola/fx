//! Exact auxiliary-message byte accounting without actor presentation serializers.
const std = @import("std");
const types = @import("../../shared/types.zig");

const Message = struct {
    role: types.ChatRole,
    content: ?[]const u8,
    images: [0]bool = .{},
    tool_call_id: ?[]const u8,
    tool_name: ?[]const u8,
    tool_calls: []const types.ToolCall,
    provider_replay: ?types.ProviderReplay,
    tool_result_status: ?types.PersistedToolStatus,
    tool_result_memory: ?bool = null,
    permission_feedback: bool,
    restored_steering: bool,
    context_origin: @FieldType(types.ChatMessage, "context_origin"),
    standalone_response: bool,
};

comptime {
    @setEvalBranchQuota(10000);
    const original = @typeInfo(types.ChatMessage).@"struct".field_names;
    const projected = @typeInfo(Message).@"struct".field_names;
    if (original.len != projected.len) @compileError("Review byte accounting must cover every message field");
    for (original, projected) |a, b| if (!std.mem.eql(u8, a, b)) @compileError("Review message fields must preserve their JSON order");
}

pub fn serializedBytes(alloc: std.mem.Allocator, messages: []const types.ChatMessage) !usize {
    const projected = try alloc.alloc(Message, messages.len);
    defer alloc.free(projected);
    for (messages, projected) |message, *out| {
        // Review/planning exchanges contain text and function results only.
        // Reject unexpected presentation data instead of omitting its bytes.
        if (message.images.len != 0 or message.tool_result_memory != null) return error.InvalidReviewMessage;
        out.* = .{
            .role = message.role,
            .content = message.content,
            .tool_call_id = message.tool_call_id,
            .tool_name = message.tool_name,
            .tool_calls = message.tool_calls,
            .provider_replay = message.provider_replay,
            .tool_result_status = message.tool_result_status,
            .permission_feedback = message.permission_feedback,
            .restored_steering = message.restored_steering,
            .context_origin = message.context_origin,
            .standalone_response = message.standalone_response,
        };
    }
    const bytes = try std.json.Stringify.valueAlloc(alloc, projected, .{});
    defer alloc.free(bytes);
    return bytes.len;
}

test "completion review byte accounting matches complete message serialization" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();
    const messages = [_]types.ChatMessage{
        .{ .role = .user, .content = "quoted \"\n\x00 and UTF-8: \xc3\xa9", .permission_feedback = true, .restored_steering = true, .context_origin = .user_turn, .standalone_response = true },
        .{ .role = .assistant, .tool_calls = &.{.{ .id = "call", .name = "omos_review_evidence", .arguments_json = "{\"action\":\"read\"}", .provisional_id = "provisional", .provider_result = "opaque result" }}, .provider_replay = .{ .source = .{ .provider = .gateway, .model = "fixture" }, .parts_json = "[{\"opaque\":\"replay\"}]" } },
        .{ .role = .tool, .tool_call_id = "call", .tool_name = "omos_review_evidence", .tool_result_status = .success, .content = "inspected bytes" },
    };
    const original = try std.json.Stringify.valueAlloc(alloc, &messages, .{});
    try std.testing.expectEqual(original.len, try serializedBytes(alloc, &messages));
    const large = try alloc.alloc(u8, 100000);
    @memset(large, 0);
    const escaped = [_]types.ChatMessage{.{ .role = .tool, .content = large }};
    const original_large = try std.json.Stringify.valueAlloc(alloc, &escaped, .{});
    try std.testing.expect(original_large.len > 512 * 1024);
    try std.testing.expectEqual(original_large.len, try serializedBytes(alloc, &escaped));
}

test "completion review byte accounting rejects unexpected actor presentation data" {
    const image = [_]types.ImageAttachment{undefined};
    try std.testing.expectError(error.InvalidReviewMessage, serializedBytes(std.testing.allocator, &.{.{ .role = .user, .images = &image }}));
    try std.testing.expectError(error.InvalidReviewMessage, serializedBytes(std.testing.allocator, &.{.{ .role = .tool, .tool_result_memory = .{} }}));
}
