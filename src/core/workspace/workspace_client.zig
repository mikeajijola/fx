//! Thin authenticated client. Mutations are never retried after an uncertain
//! response; the caller must reconcile against the server's retained records.
const std = @import("std");
const io = @import("../shared/io.zig");

pub fn call(alloc: std.mem.Allocator, base_url: []const u8, body: ?[]const u8) !std.json.Value {
    const base = try std.Uri.parse(base_url);
    if (base.user != null or base.password != null or base.query != null or base.fragment != null or base.host == null) return error.InvalidWorkspaceEndpoint;
    const host = try base.host.?.toRawMaybeAlloc(alloc);
    const loopback = std.mem.eql(u8, host, "127.0.0.1") or std.ascii.eqlIgnoreCase(host, "localhost") or std.mem.eql(u8, host, "[::1]");
    if (!std.ascii.eqlIgnoreCase(base.scheme, "https") and !(std.ascii.eqlIgnoreCase(base.scheme, "http") and loopback)) return error.InsecureWorkspaceEndpoint;
    const token = io.getenv("OMOS_WORKSPACE_TOKEN") orelse return error.MissingWorkspaceServiceToken;
    if (token.len < 32 or token.len > 1024 or std.mem.findScalar(u8, token, '\r') != null or std.mem.findScalar(u8, token, '\n') != null) return error.InvalidWorkspaceServiceToken;
    const url = try alloc.print("{s}{s}", .{ std.mem.trimEnd(u8, base_url, "/"), if (body != null) "/v1/workspace" else "/v1/definition" });
    const bearer = try alloc.print("Bearer {s}", .{token});
    var client: std.http.Client = .{ .allocator = alloc, .io = io.getIo() };
    defer client.deinit();
    var request = try client.request(if (body == null) .GET else .POST, try std.Uri.parse(url), .{
        .redirect_behavior = .unhandled,
        .headers = .{ .authorization = .{ .override = bearer }, .content_type = .{ .override = "application/json" }, .accept_encoding = .omit },
    });
    defer request.deinit();
    if (body) |raw| try request.sendBodyComplete(@constCast(raw)) else try request.sendBodiless();
    var response = request.receiveHead(&.{}) catch return error.WorkspaceServiceOutcomeUnknown;
    if (response.head.status == .conflict) return error.WorkspaceServiceConflict;
    if (response.head.status == .unauthorized or response.head.status == .forbidden) return error.WorkspaceServiceDenied;
    if (response.head.status != .ok) return error.WorkspaceServiceRejected;
    var transfer: [4096]u8 = undefined;
    const raw = response.reader(&transfer).allocRemaining(alloc, .limited(1024 * 1024)) catch return error.WorkspaceServiceOutcomeUnknown;
    return (try std.json.parseFromSlice(std.json.Value, alloc, raw, .{})).value;
}
