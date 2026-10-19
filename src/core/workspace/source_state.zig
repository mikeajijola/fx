//! Hash the files the native repository indexer exposes. No repository program
//! runs. An incomplete scan cannot establish a current validation basis.
const std = @import("std");
const io = @import("../shared/io.zig");
const indexer = @import("../indexer/indexer.zig");

pub fn fingerprint(alloc: std.mem.Allocator, root: []const u8, repository: []const u8) ![]const u8 {
    var scan = try indexer.scan(alloc, root, .{ .candidate_cap = 100_000, .max_workers = 2 }, null);
    defer scan.deinit();
    if (scan.tree.incomplete or scan.tree.cap_reached) return error.SourceStateIncomplete;
    for (scan.tree.folders) |folder| if (folder.boundary) return error.SourceScopeIncomplete;
    var hasher = std.crypto.hash.sha2.Sha256.init(.{});
    var total: usize = 0;
    for (scan.tree.entries) |entry| {
        if (entry.kind != .file) continue;
        const path = try std.Io.Dir.path.join(alloc, &.{ root, entry.path });
        defer alloc.free(path);
        if (std.mem.eql(u8, path, repository)) continue;
        const stat = try std.Io.Dir.cwd().statFile(io.getIo(), path, .{ .follow_symlinks = false });
        if (stat.kind == .sym_link) {
            var link: [std.Io.Dir.max_path_bytes]u8 = undefined;
            const length = try std.Io.Dir.cwd().readLink(io.getIo(), path, &link);
            hasher.update(entry.path);
            hasher.update(&.{0});
            hasher.update(link[0..length]);
            continue;
        }
        var file = try std.Io.Dir.cwd().openFile(io.getIo(), path, .{ .allow_directory = false, .follow_symlinks = false });
        defer file.close(io.getIo());
        const bytes = try io.readFileToEnd(alloc, &file, 16 * 1024 * 1024);
        defer alloc.free(bytes);
        total += bytes.len;
        if (total > 256 * 1024 * 1024) return error.SourceStateTooLarge;
        hasher.update(entry.path);
        hasher.update(&.{0});
        var content_hash: [32]u8 = undefined;
        std.crypto.hash.sha2.Sha256.hash(bytes, &content_hash, .{});
        hasher.update(&content_hash);
    }
    var digest: [32]u8 = undefined;
    hasher.final(&digest);
    return alloc.dupe(u8, &std.fmt.bytesToHex(&digest, .lower));
}
