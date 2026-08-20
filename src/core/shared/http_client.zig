const std = @import("std");
const builtin = @import("builtin");
const io_mod = @import("io.zig");

const Allocator = std.mem.Allocator;

pub fn init(alloc: Allocator) !std.http.Client {
    var client: std.http.Client = .{ .allocator = alloc, .io = io_mod.getIo() };
    errdefer client.deinit();

    if (builtin.abi == .android) {
        const prefix = io_mod.getenv("PREFIX") orelse "/data/data/com.termux/files/usr";
        const cert_path = try std.fs.path.join(alloc, &.{ prefix, "etc/tls/cert.pem" });
        defer alloc.free(cert_path);

        const now = std.Io.Clock.real.now(io_mod.getIo());
        try client.ca_bundle.addCertsFromFilePathAbsolute(
            alloc,
            io_mod.getIo(),
            now,
            cert_path,
        );
        client.now = now;
    }

    return client;
}
