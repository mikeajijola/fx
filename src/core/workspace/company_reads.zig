//! Versioned read dependencies, including empty results and missing files.
//! These observations preserve inputs; they never grant content access.
const std = @import("std");
const workspace = @import("fossil_workspace.zig");
const authority = @import("company_authority.zig");
const model = @import("definition.zig");
const records = @import("../shared/record_json.zig");

pub fn supported(declaration: model.Declaration) bool {
    var observation = false;
    var submission = false;
    var view = false;
    for (declaration.semantic.entityTypes) |entity| {
        if (std.mem.eql(u8, entity.id, "omos_company_read")) observation = true;
        if (std.mem.eql(u8, entity.id, "omos_company_submission")) submission = true;
        if (std.mem.eql(u8, entity.id, "omos_workspace_view") and model.field(entity.fields, "reads") != null) view = true;
    }
    return observation and submission and view;
}

pub const Reference = struct { path: []const u8, revision: []const u8 = "", selector: []const u8 };
const File = struct { path: []const u8, observed_hash: ?[]const u8, base_hash: ?[]const u8 };
const Kind = enum { file, query, inventory };
pub const Observation = struct {
    version: []const u8 = "omos.company-read/v1",
    workspace: []const u8,
    task: []const u8,
    actor: []const u8,
    grant: []const u8,
    selector: []const u8,
    revision: []const u8,
    base_revision: []const u8,
    paths: []const []const u8,
    kind: Kind,
    entity: ?[]const u8 = null,
    membership_hash: ?[]const u8 = null,
    base_membership_hash: ?[]const u8 = null,
    files: []const File,
};

fn encode(alloc: std.mem.Allocator, value: anytype) ![]const u8 {
    return std.json.Stringify.valueAlloc(alloc, value, .{});
}

pub fn recordPath(alloc: std.mem.Allocator, value: Observation) ![]const u8 {
    return alloc.print("company/reads/{s}/{s}.json", .{ value.task, try workspace.hash(alloc, try encode(alloc, value)) });
}

fn contains(paths: []const []const u8, path: []const u8) bool {
    for (paths) |entry| if (std.mem.eql(u8, entry, path)) return true;
    return false;
}

fn fileHash(manager: workspace.Manager, inventory: []const []const u8, path: []const u8, revision: []const u8) !?[]const u8 {
    if (!contains(inventory, path)) return null;
    var scratch = std.heap.ArenaAllocator.init(std.heap.c_allocator);
    defer scratch.deinit();
    var scoped = manager;
    scoped.alloc = scratch.allocator();
    return try manager.alloc.dupe(u8, try workspace.hash(scoped.alloc, try scoped.contentAt(path, revision)));
}

fn membershipHash(alloc: std.mem.Allocator, inventory: []const []const u8, paths: []const []const u8, kind: Kind, entity: ?[]const u8) ![]const u8 {
    const permitted: authority.Grant = .{ .id = "read", .actor = "read", .public_key = "", .paths = paths, .actions = &.{}, .expires_ms = 0 };
    var selected: std.ArrayList([]const u8) = .empty;
    for (inventory) |path| {
        if (!authority.permitsPath(permitted, path)) continue;
        if (kind == .query) {
            const row = @import("company_records.zig").identity(path) orelse continue;
            if (entity) |filter| if (!std.mem.eql(u8, row.entity, filter)) continue;
        }
        try selected.append(alloc, path);
    }
    std.mem.sort([]const u8, selected.items, {}, struct {
        fn less(_: void, left: []const u8, right: []const u8) bool {
            return std.mem.order(u8, left, right) == .lt;
        }
    }.less);
    return workspace.hash(alloc, try encode(alloc, selected.items));
}

pub fn observe(manager: workspace.Manager, task: workspace.Task, grant: authority.Grant, request: authority.Request, revision: []const u8, result: std.json.Value) !Observation {
    const kind: Kind = if (request.action == .read) .file else if (request.action == .query) .query else .inventory;
    const base_files = try manager.inventory(task.base_revision);
    var files: std.ArrayList(File) = .empty;
    if (kind == .file) {
        const path = request.path orelse return error.MissingPath;
        const observed = model.field(result, "sha256") orelse return error.InvalidCompanyRead;
        if (observed != .string and observed != .null) return error.InvalidCompanyRead;
        try files.append(manager.alloc, .{ .path = path, .observed_hash = if (observed == .string) observed.string else null, .base_hash = try fileHash(manager, base_files, path, task.base_revision) });
    } else {
        for (model.items(result, if (kind == .query) "records" else "files")) |row| {
            const path = model.text(row, if (kind == .query) "source_path" else "path");
            if (!authority.permitsPath(grant, path)) return error.CompanyAccessDenied;
            const observed = model.text(row, "sha256");
            if (observed.len != 64) return error.InvalidCompanyRead;
            try files.append(manager.alloc, .{ .path = path, .observed_hash = observed, .base_hash = try fileHash(manager, base_files, path, task.base_revision) });
        }
    }
    return .{
        .workspace = manager.manifest.id,
        .task = task.id,
        .actor = grant.actor,
        .grant = grant.id,
        .selector = try workspace.hash(manager.alloc, try encode(manager.alloc, .{ kind, request.path, request.entity, if (kind == .file) @as(usize, 0) else request.offset, if (kind == .file) @as(usize, 0) else request.limit })),
        .revision = revision,
        .base_revision = task.base_revision,
        .paths = grant.paths,
        .kind = kind,
        .entity = request.entity,
        .membership_hash = if (kind == .file) null else try membershipHash(manager.alloc, try manager.inventory(revision), grant.paths, kind, request.entity),
        .base_membership_hash = if (kind == .file) null else try membershipHash(manager.alloc, base_files, grant.paths, kind, request.entity),
        .files = files.items,
    };
}

fn equal(left: ?[]const u8, right: ?[]const u8) bool {
    return if (left) |value| if (right) |other| std.mem.eql(u8, value, other) else false else right == null;
}

pub fn validate(manager: workspace.Manager, task: workspace.Task, references: []const Reference, target: []const u8) !void {
    if (references.len == 0) return;
    if (comptime @import("builtin").target.cpu.arch.isWasm()) return error.UnsupportedPlatform;
    if (references.len > 100) return error.CompanyReadSetTooLarge;
    const binding = task.authority orelse return error.CompanyAccessDenied;
    const inventory = try manager.inventory(target);
    for (references) |reference| {
        var scratch = std.heap.ArenaAllocator.init(std.heap.c_allocator);
        defer scratch.deinit();
        var scoped = manager;
        scoped.alloc = scratch.allocator();
        const value = try records.decode(Observation, scoped.alloc, try scoped.contentAt(reference.path, reference.revision), .{});
        if (!std.mem.eql(u8, value.version, "omos.company-read/v1") or !std.mem.eql(u8, value.workspace, manager.manifest.id) or !std.mem.eql(u8, value.task, task.id) or !std.mem.eql(u8, value.actor, binding.actor) or !std.mem.eql(u8, value.grant, binding.grant) or !std.mem.eql(u8, value.selector, reference.selector) or !std.mem.eql(u8, reference.path, try recordPath(scoped.alloc, value))) return error.InvalidCompanyRead;
        if (value.kind != .file) {
            const current = try membershipHash(scoped.alloc, inventory, value.paths, value.kind, value.entity);
            if (!equal(current, value.membership_hash) and !equal(current, value.base_membership_hash)) return error.WorkspaceReadDependencyChanged;
        }
        for (value.files) |file| {
            const current = try fileHash(scoped, inventory, file.path, target);
            if (!equal(current, file.observed_hash) and !equal(current, file.base_hash)) return error.WorkspaceReadDependencyChanged;
        }
    }
}

test "company read membership excludes inaccessible and unrelated records" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();
    const initial = try membershipHash(alloc, &.{ "records/note/a.json", "records/note/private.json", "records/other/elsewhere.json" }, &.{"records/note/a.json"}, .query, "note");
    const unaffected = try membershipHash(alloc, &.{ "records/note/a.json", "records/note/private.json", "records/note/another-private.json" }, &.{"records/note/a.json"}, .query, "note");
    try std.testing.expectEqualStrings(initial, unaffected);
    const absent = try membershipHash(alloc, &.{}, &.{"records/note/"}, .query, "note");
    const present = try membershipHash(alloc, &.{"records/note/a.json"}, &.{"records/note/"}, .query, "note");
    try std.testing.expect(!std.mem.eql(u8, absent, present));
    try std.testing.expect(!equal(null, "present"));
    try std.testing.expect(equal(null, null));
}
