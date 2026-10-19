//! Owned JSON decoding for host records within an operation's arena.
const std = @import("std");

/// Decode statically typed records without dynamic std.json.Value fields.
pub fn decode(comptime T: type, alloc: std.mem.Allocator, bytes: []const u8, options: std.json.ParseOptions) !T {
    return std.json.parseFromValueLeaky(T, alloc, try tokens(alloc, bytes, options), options);
}

// Share the tokenizer rather than generating one for every host record type.
// Numeric text stays exact until conversion to the declared integer width.
noinline fn tokens(alloc: std.mem.Allocator, bytes: []const u8, options: std.json.ParseOptions) !std.json.Value {
    var owned = options;
    owned.allocate = .alloc_always;
    owned.parse_numbers = false;
    return std.json.parseFromSliceLeaky(std.json.Value, alloc, bytes, owned);
}
