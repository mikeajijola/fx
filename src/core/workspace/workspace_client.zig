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
    const company = if (body) |raw| blk: {
        const envelope = (std.json.parseFromSlice(std.json.Value, alloc, raw, .{}) catch break :blk false).value;
        break :blk envelope == .object and envelope.object.contains("payload") and envelope.object.contains("signature");
    } else false;
    // Actor requests carry their own scoped signature. The installation's
    // owner token must never follow them to a company endpoint.
    const token: ?[]const u8 = if (company) null else io.getenv("OMOS_WORKSPACE_TOKEN") orelse return error.MissingWorkspaceServiceToken;
    if (token) |value| if (value.len < 32 or value.len > 1024 or std.mem.findScalar(u8, value, '\r') != null or std.mem.findScalar(u8, value, '\n') != null) return error.InvalidWorkspaceServiceToken;
    const url = try alloc.print("{s}{s}", .{ std.mem.trimEnd(u8, base_url, "/"), if (company) "/v1/company" else if (body != null) "/v1/workspace" else "/v1/definition" });
    const bearer = if (token) |value| try alloc.print("Bearer {s}", .{value}) else null;
    var client: std.http.Client = .{ .allocator = alloc, .io = io.getIo() };
    defer client.deinit();
    var request = try client.request(if (body == null) .GET else .POST, try std.Uri.parse(url), .{
        .redirect_behavior = .unhandled,
        .headers = .{ .authorization = if (bearer) |value| .{ .override = value } else .omit, .content_type = .{ .override = "application/json" }, .accept_encoding = .omit },
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
