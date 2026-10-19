//! Bounded views of retained evidence. A preview is never proof of unseen bytes.
const std = @import("std");
const sort_utils = @import("../../shared/sort_utils.zig");
const types = @import("../../shared/types.zig");
const record_json = @import("../../shared/record_json.zig");

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
    raw_ranges: std.ArrayList(struct { ordinal: usize, start: usize, end: usize }) = .empty,

    pub fn rawInspected(self: View, ordinal: usize, offset: usize, bytes: usize) bool {
        var cursor = offset;
        while (cursor < offset + bytes) {
            var next = cursor;
            for (self.raw_ranges.items) |range| {
                if (range.ordinal == ordinal and range.start <= cursor) next = @max(next, range.end);
            }
            if (next == cursor) return false;
            cursor = next;
        }
        return true;
    }

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
            if (complete) {
                self.inspected[ordinal] = payload.len;
                try self.raw_ranges.append(alloc, .{ .ordinal = ordinal, .start = 0, .end = payload.len });
            }
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
        const command = try record_json.decode(Command, alloc, raw, .{});
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
            if (chunk.len == 0 and command.offset < payload.len) return error.InvalidEvidenceOffset;
            try self.raw_ranges.append(alloc, .{ .ordinal = ordinal, .start = command.offset, .end = command.offset + chunk.len });
            if (command.offset <= self.inspected[ordinal]) self.inspected[ordinal] = @max(self.inspected[ordinal], command.offset + chunk.len);
            return std.json.Stringify.valueAlloc(alloc, .{
                .id = id,
                .offset = command.offset,
                .content = chunk,
                .bytes = payload.len,
                .sha256 = try payloadHash(alloc, payload),
                .nextOffset = if (command.offset + chunk.len < payload.len) command.offset + chunk.len else @as(?usize, null),
                .fullyInspected = self.inspected[ordinal] == payload.len,
            }, .{});
        }
        return error.InvalidContractEvidence;
    }

    /// Replay only pages whose complete payload hash still matches. The full
    /// regenerated bytes are included in the next assessor packet.
    pub fn restorePages(self: *View, alloc: std.mem.Allocator, saved: []const []const u8) ![]const std.json.Value {
        const Saved = struct { id: []const u8, offset: usize, bytes: usize, sha256: []const u8, content: []const u8 };
        var pages: std.ArrayList(Saved) = .empty;
        for (saved) |raw| {
            // List replies are journaled too, but contain no record bytes.
            const page_value = record_json.decode(Saved, alloc, raw, .{ .ignore_unknown_fields = true }) catch continue;
            try pages.append(alloc, page_value);
        }
        sort_utils.sort(Saved, pages.items, {}, struct {
            fn less(_: void, a: Saved, b: Saved) bool {
                const order = std.mem.order(u8, a.id, b.id);
                return order == .lt or (order == .eq and a.offset < b.offset);
            }
        }.less);
        var restored: std.ArrayList(std.json.Value) = .empty;
        var seen: std.StringHashMapUnmanaged(void) = .empty;
        var total: usize = 0;
        for (pages.items) |page_value| {
            if (page_value.content.len == 0) continue;
            const key = try alloc.print("{s}:{d}:{d}:{s}", .{ page_value.id, page_value.offset, page_value.content.len, page_value.sha256 });
            if (seen.contains(key)) continue;
            try seen.put(alloc, key, {});
            for (self.records, 0..) |record, i| {
                if (!std.mem.eql(u8, record.id, page_value.id)) continue;
                const payload = self.payloads[i];
                if (payload.len != page_value.bytes or !std.mem.eql(u8, try payloadHash(alloc, payload), page_value.sha256)) break;
                if (page_value.offset > payload.len or page_value.content.len > payload.len - page_value.offset or !std.mem.eql(u8, payload[page_value.offset..][0..page_value.content.len], page_value.content)) break;
                if (page_value.offset + page_value.content.len <= self.inspected[i]) break;
                // Large records advance through independent segment decisions,
                // rather than accumulating all earlier raw pages in one packet.
                const previous_inspected = self.inspected[i];
                const regenerated = try self.page(alloc, try std.json.Stringify.valueAlloc(alloc, .{ .action = "read", .id = page_value.id, .offset = page_value.offset, .limit = page_value.content.len }, .{}));
                if (total + regenerated.len > 160 * 1024) {
                    // This page was not delivered in the next packet.
                    self.raw_ranges.items.len -= 1;
                    self.inspected[i] = previous_inspected;
                    break;
                }
                total += regenerated.len;
                try restored.append(alloc, (try std.json.parseFromSlice(std.json.Value, alloc, regenerated, .{})).value);
                break;
            }
        }
        return restored.items;
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

fn payloadHash(alloc: std.mem.Allocator, payload: []const u8) ![]const u8 {
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(payload, &digest, .{});
    return alloc.dupe(u8, &std.fmt.bytesToHex(&digest, .lower));
}

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

test "completion review restores record pages without interpreting manifest lists as records" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();
    const content = try alloc.alloc(u8, 8192);
    @memset(content, 'x');
    var original = try View.init(alloc, &.{.{ .id = "receipt", .content = content }});
    const list = try original.page(alloc, "{\"action\":\"list\"}");
    const read = try original.page(alloc, "{\"action\":\"read\",\"id\":\"receipt\"}");
    var resumed = try View.init(alloc, original.records);
    const pages = try resumed.restorePages(alloc, &.{ list, read });
    try std.testing.expectEqual(@as(usize, 1), pages.len);
    try resumed.requireInspected("receipt");
    var changed = try View.init(alloc, &.{.{ .id = "receipt", .content = "changed" }});
    try std.testing.expectEqual(@as(usize, 0), (try changed.restorePages(alloc, &.{read})).len);
    try std.testing.expectError(error.UninspectedContractEvidence, changed.requireInspected("receipt"));
    try std.testing.expectError(error.InvalidEvidenceOffset, original.page(alloc, "{\"action\":\"read\",\"id\":\"receipt\",\"limit\":0}"));
}
