//! Signed, scoped company operations over the same Fossil manager. The shared
//! bearer endpoint remains a local-owner API; company callers use actor keys.
const std = @import("std");
const io = @import("../shared/io.zig");
const workspace = @import("fossil_workspace.zig");
const authority = @import("company_authority.zig");
const records = @import("../shared/record_json.zig");
const keys = @import("company_keys.zig");
const model = @import("definition.zig");

const Journal = struct {
    version: []const u8 = "omos.company-operation/v1",
    actor: []const u8,
    grant: []const u8,
    operation: []const u8,
    request_hash: []const u8,
    state: enum { pending, completed, failed, uncertain },
    result: ?[]const u8 = null,
    failure: ?[]const u8 = null,
    view: ?[]const u8 = null,
};
const View = struct { id: []const u8, actor: []const u8, grant: []const u8, task: []const u8, base: []const u8, pending: ?[]const u8 = null };
const Admin = struct {
    version: []const u8,
    action: enum { initialize, status, grant, revoke, rotate },
    revision: ?[]const u8 = null,
    grant: ?authority.Grant = null,
    id: ?[]const u8 = null,
};
fn encode(alloc: std.mem.Allocator, value: anytype) ![]const u8 {
    return std.json.Stringify.valueAlloc(alloc, value, .{});
}
fn parse(alloc: std.mem.Allocator, bytes: []const u8) !std.json.Value {
    return std.json.parseFromSliceLeaky(std.json.Value, alloc, bytes, .{ .allocate = .alloc_always });
}
fn state(manager: workspace.Manager) !authority.State {
    const value = try records.decode(authority.State, manager.alloc, try manager.companyContent("authority/state.json"), .{});
    if (!std.mem.eql(u8, value.version, "omos.company-authority/v1") or !std.mem.eql(u8, value.workspace, manager.manifest.id)) return error.WorkspaceIdentityMismatch;
    return value;
}

/// Administrative changes require local operator access. OmniForm definitions
/// and scoped actor requests can never enroll or enlarge a root authority.
pub fn administer(original: workspace.Manager, raw: []const u8) ![]const u8 {
    var manager = original;
    const request = try records.decode(Admin, manager.alloc, raw, .{});
    if (!std.mem.eql(u8, request.version, "omos.company-admin/v1")) return error.UnsupportedCompanyApi;
    const lease = try manager.companyOperationLease();
    defer lease.release();
    manager.company_operation_held = true;
    const recovery_lease = if (request.action == .rotate) try keys.recoveryLease(manager) else null;
    defer if (recovery_lease) |held| held.release();
    const revision_id = try manager.companyRevision();
    if (request.action == .status) return encode(manager.alloc, .{ .revision = revision_id, .authority = try state(manager) });
    if (request.action != .initialize and request.action != .rotate) try validateInstance(manager);
    if (!equal(request.revision, revision_id)) return error.WorkspaceRevisionChanged;
    var current: authority.State = undefined;
    if (request.action == .initialize) {
        if (revision_id != null) return error.CompanyAlreadyInitialized;
        const key = try keys.prepare(manager, 1, false);
        current = .{ .workspace = manager.manifest.id, .issuer = try manager.alloc.dupe(u8, &std.fmt.bytesToHex(key.public_key.toBytes(), .lower)) };
    } else {
        current = try state(manager);
        if (request.action == .grant) {
            const grant = request.grant orelse return error.InvalidCompanyGrant;
            if (grant.parent != null) return error.InvalidCompanyDelegation;
            try authority.validateGrant(current, grant, io.milliTimestamp());
            for (current.grants) |existing| if (std.mem.eql(u8, existing.id, grant.id)) return error.CompanyGrantAlreadyExists;
            const grants = try manager.alloc.alloc(authority.Grant, current.grants.len + 1);
            @memcpy(grants[0..current.grants.len], current.grants);
            grants[current.grants.len] = grant;
            current.grants = grants;
        } else if (request.action == .revoke) {
            const id = request.id orelse return error.InvalidCompanyIdentity;
            const grants = try manager.alloc.dupe(authority.Grant, current.grants);
            const selected = for (grants) |*grant| {
                if (std.mem.eql(u8, grant.id, id)) break grant;
            } else return error.InvalidCompanyIdentity;
            selected.revoked = true;
            current.grants = grants;
        } else if (request.action == .rotate) {
            // Restoring a repository never restores issuer power implicitly.
            // An operator must recover/create the protected key and advance the
            // epoch. All old grants remain recorded but become revoked.
            const epoch = try keys.nextEpoch(manager, current.epoch);
            const key = try keys.prepare(manager, epoch, true);
            current.issuer = try manager.alloc.dupe(u8, &std.fmt.bytesToHex(key.public_key.toBytes(), .lower));
            current.epoch = epoch;
            const grants = try manager.alloc.dupe(authority.Grant, current.grants);
            for (grants) |*grant| grant.revoked = true;
            current.grants = grants;
        }
    }
    const revision = try manager.companyWrite(revision_id, &.{.{ .path = "authority/state.json", .content = try encode(manager.alloc, current) }});
    return encode(manager.alloc, .{ .revision = revision, .authority = current });
}
fn equal(a: ?[]const u8, b: ?[]const u8) bool {
    return if (a) |left| if (b) |right| std.mem.eql(u8, left, right) else false else b == null;
}
fn operationPath(manager: workspace.Manager, actor: []const u8, operation: []const u8) ![]const u8 {
    return manager.alloc.print("company/operations/{s}.json", .{try workspace.hash(manager.alloc, try encode(manager.alloc, .{ actor, operation }))});
}
fn loadJournal(manager: workspace.Manager, path: []const u8) !?Journal {
    const revision_id = (try manager.companyRevision()) orelse return error.CompanyNotInitialized;
    for (try manager.inventory(revision_id)) |entry| if (std.mem.eql(u8, entry, path)) return try records.decode(Journal, manager.alloc, try manager.contentAt(path, revision_id), .{});
    return null;
}
fn saveJournal(manager: workspace.Manager, path: []const u8, journal: Journal) !void {
    var files: std.ArrayList(workspace.Manager.CompanyFile) = .empty;
    try files.append(manager.alloc, .{ .path = path, .content = try encode(manager.alloc, journal) });
    if (journal.view) |id| {
        if (!authority.safeIdentity(id)) return error.InvalidCompanyIdentity;
        const view_path = try manager.alloc.print("company/views/{s}.json", .{id});
        var view = try records.decode(View, manager.alloc, try manager.companyContent(view_path), .{});
        if (view.pending) |pending| if (!std.mem.eql(u8, pending, journal.operation)) return error.CompanyOperationRecoveryRequired;
        view.pending = if (journal.state == .pending or journal.state == .uncertain) journal.operation else null;
        try files.append(manager.alloc, .{ .path = view_path, .content = try encode(manager.alloc, view) });
    }
    _ = try manager.companyWrite(try manager.companyRevision(), files.items);
}
fn signed(manager: workspace.Manager, current: authority.State, request: authority.Request, request_hash: []const u8, result: []const u8) ![]const u8 {
    const key = try keys.current(manager, current.epoch, current.issuer);
    const public = std.fmt.bytesToHex(key.public_key.toBytes(), .lower);
    if (!std.mem.eql(u8, &public, current.issuer)) return error.CompanyIssuerRecoveryRequired;
    const payload = try encode(manager.alloc, .{ .version = "omos.company-receipt/v1", .workspace = current.workspace, .actor = request.actor, .grant = request.grant, .operation = request.operation, .request_hash = request_hash, .action = request.action, .epoch = current.epoch, .result = try parse(manager.alloc, result) });
    const signature = try key.sign(payload, null);
    const signature_hex = std.fmt.bytesToHex(signature.toBytes(), .lower);
    return encode(manager.alloc, .{ .payload = payload, .signature = &signature_hex, .issuer = &public });
}

pub fn validateInstance(manager: workspace.Manager) !void {
    if (try manager.companyRevision() == null) return;
    const current = try state(manager);
    _ = try keys.current(manager, current.epoch, current.issuer);
}

pub fn bootstrap(manager: workspace.Manager) ![]const u8 {
    const lease = try manager.companyOperationLease();
    defer lease.release();
    const current = try state(manager);
    _ = try keys.current(manager, current.epoch, current.issuer);
    return encode(manager.alloc, .{ .version = "omos.company/v1", .workspace = current.workspace, .issuer = current.issuer, .epoch = current.epoch, .revision = try manager.revision("trunk"), .features = .{ .scope = "path", .merge = "record_or_file", .max_read_bytes = 16384, .max_object_bytes = 8 * 1024 * 1024 } });
}

pub fn execute(original: workspace.Manager, raw: []const u8, writable: bool) ![]const u8 {
    var manager = original;
    const lease = try manager.companyOperationLease();
    defer lease.release();
    manager.company_operation_held = true;
    const current = try state(manager);
    const declaration = try manager.loadDeclaration(((try manager.modelBasis("trunk")) orelse return error.WorkspaceMigrationRequired).revision);
    try model.validateOperation(manager.alloc, declaration, "omos_company_request", try parse(manager.alloc, raw), .input);
    const request = try authority.authenticate(manager.alloc, current, raw, io.milliTimestamp());
    try model.validateOperation(manager.alloc, declaration, "omos_company_operation", try parse(manager.alloc, (try records.decode(authority.Envelope, manager.alloc, raw, .{})).payload), .input);
    const grant = try authority.liveGrant(current, request.grant, io.milliTimestamp());
    const mutation = request.action == .create_view or request.action == .checkpoint or request.action == .submit or request.action == .delegate;
    if (mutation and !writable) return error.ServiceReadOnly;
    if (mutation) if (request.view) |id| {
        const selected = try loadView(manager, grant, id);
        if (selected.view.pending) |pending| if (!std.mem.eql(u8, pending, request.operation)) return error.CompanyOperationRecoveryRequired;
    };
    // Never perform an effect without the key needed to acknowledge it.
    _ = try keys.current(manager, current.epoch, current.issuer);
    const path = try operationPath(manager, request.actor, request.operation);
    const request_hash = try workspace.hash(manager.alloc, (try records.decode(authority.Envelope, manager.alloc, raw, .{})).payload);
    const retained = try loadJournal(manager, path);
    if (retained) |previous| {
        if (!std.mem.eql(u8, previous.request_hash, request_hash) or !std.mem.eql(u8, previous.grant, grant.id)) return error.CompanyOperationConflict;
        if (previous.state == .completed) return signed(manager, current, request, request_hash, previous.result.?);
        if (previous.state == .failed) return error.CompanyOperationFailed;
        // Only internal idempotent operations below can replay. No external
        // command or provider effect is dispatched by this API.
    }
    var journal: Journal = .{ .actor = request.actor, .grant = request.grant, .operation = request.operation, .request_hash = request_hash, .state = .pending, .view = request.view };
    if (mutation and retained == null) try saveJournal(manager, path, journal);
    const result = perform(manager, current, grant, request, request_hash) catch |err| {
        if (mutation) {
            journal.state = if (err == error.WorkspaceRevisionChanged or err == error.CompanyAccessDenied or err == error.WorkspaceProjectionConflict) .failed else .uncertain;
            journal.failure = @errorName(err);
            try saveJournal(manager, path, journal);
        }
        return err;
    };
    if (mutation) {
        journal.state = .completed;
        journal.result = result;
        try saveJournal(manager, path, journal);
    }
    const response = try signed(manager, current, request, request_hash, result);
    try model.validateOperation(manager.alloc, declaration, "omos_company_request", try parse(manager.alloc, response), .output);
    return response;
}

fn loadView(manager: workspace.Manager, grant: authority.Grant, id: []const u8) !struct { view: View, task: workspace.Task } {
    if (!authority.safeIdentity(id)) return error.InvalidCompanyIdentity;
    const view = try records.decode(View, manager.alloc, try manager.companyContent(try manager.alloc.print("company/views/{s}.json", .{id})), .{});
    if (!std.mem.eql(u8, view.actor, grant.actor) or !std.mem.eql(u8, view.grant, grant.id)) return error.CompanyAccessDenied;
    return .{ .view = view, .task = try manager.loadTask(view.task) };
}

fn perform(original: workspace.Manager, current: authority.State, grant: authority.Grant, request: authority.Request, operation_hash: []const u8) ![]const u8 {
    var manager = original;
    const alloc = manager.alloc;
    const selected = if (request.view) |id| try loadView(manager, grant, id) else null;
    const revision_id = if (selected) |view| try manager.currentRevision(view.task) else try manager.revision("trunk");
    if (request.action == .create_view) {
        const objective = request.objective orelse return error.MissingCompanyObjective;
        if (objective.len == 0 or objective.len > 16384) return error.InvalidCompanyObjective;
        const id = try workspace.hash(alloc, try encode(alloc, .{ request.actor, request.operation }));
        const session = try alloc.print("company-{s}", .{id});
        const project = try std.Io.Dir.path.join(alloc, &.{ manager.root, "company-workers", id });
        const previous = try manager.active(session);
        if (previous == null and (request.revision == null or !std.mem.eql(u8, request.revision.?, revision_id))) return error.WorkspaceRevisionChanged;
        const binding: authority.Binding = .{ .actor = grant.actor, .grant = grant.id };
        const task = if (previous) |value| try manager.bindCompanyTask(value, binding) else try manager.startCompany(session, project, objective, binding);
        const view: View = .{ .id = id, .actor = grant.actor, .grant = grant.id, .task = task.id, .base = task.base_revision };
        _ = try manager.companyWrite(try manager.companyRevision(), &.{.{ .path = try alloc.print("company/views/{s}.json", .{id}), .content = try encode(alloc, view) }});
        return encode(alloc, .{ .view = id, .revision = try manager.currentRevision(task), .base = task.base_revision, .contract = task.definition, .basis = task.model_basis });
    }
    if (request.action == .delegate) {
        const delegated = request.delegated_grant orelse return error.InvalidCompanyGrant;
        if (delegated.parent == null or !std.mem.eql(u8, delegated.parent.?, grant.id)) return error.CompanyDelegationDenied;
        try authority.validateGrant(current, delegated, io.milliTimestamp());
        for (current.grants) |existing| if (std.mem.eql(u8, existing.id, delegated.id)) {
            if (!std.mem.eql(u8, try encode(alloc, existing), try encode(alloc, delegated))) return error.CompanyGrantAlreadyExists;
            return encode(alloc, .{ .grant = delegated.id, .state = "delegated" });
        };
        var next = current;
        const grants = try alloc.alloc(authority.Grant, current.grants.len + 1);
        @memcpy(grants[0..current.grants.len], current.grants);
        grants[current.grants.len] = delegated;
        next.grants = grants;
        _ = try manager.companyWrite(try manager.companyRevision(), &.{.{ .path = "authority/state.json", .content = try encode(alloc, next) }});
        return encode(alloc, .{ .grant = delegated.id, .state = "delegated" });
    }
    if (request.action == .status) {
        if (request.outcome) |id| {
            if (!authority.safeIdentity(id)) return error.InvalidCompanyIdentity;
            const journal = (try loadJournal(manager, try operationPath(manager, grant.actor, id))) orelse return error.CompanyOutcomeNotFound;
            if (!std.mem.eql(u8, journal.grant, grant.id)) return error.CompanyAccessDenied;
            return encode(alloc, .{ .operation = id, .state = @tagName(journal.state), .failure = journal.failure, .result = if (journal.result) |value| try parse(alloc, value) else null });
        }
        const view = selected orelse return error.CompanyViewRequired;
        const job = if (view.task.review_job) |id| try manager.loadReviewJob(view.task, id) else null;
        return encode(alloc, .{ .view = view.view.id, .revision = revision_id, .state = @tagName(view.task.state), .job = job });
    }
    if (request.action == .checkpoint) {
        const view = selected orelse return error.CompanyViewRequired;
        if (try manager.companyCheckpointed(view.task, operation_hash)) return encode(alloc, .{ .view = view.view.id, .revision = revision_id, .state = "checkpointed" });
        if (request.revision == null or !std.mem.eql(u8, request.revision.?, revision_id)) return error.WorkspaceRevisionChanged;
        const path = request.path orelse return error.MissingPath;
        if (!authority.permitsPath(grant, path)) return error.CompanyAccessDenied;
        const bytes: ?[]const u8 = if (request.remove) null else if (request.encoding == .utf8) request.content orelse return error.MissingContent else blk: {
            const encoded = request.content orelse return error.MissingContent;
            const result = try alloc.alloc(u8, try std.base64.standard.Decoder.calcSizeForSlice(encoded));
            try std.base64.standard.Decoder.decode(result, encoded);
            break :blk result;
        };
        manager.expected_revision = request.revision;
        const revision = try manager.checkpointCompanyContent(view.task, &.{.{ .path = path, .content = bytes, .previous_hash = request.previous_hash }}, operation_hash);
        return encode(alloc, .{ .view = view.view.id, .revision = revision, .state = "checkpointed" });
    }
    if (request.action == .submit) {
        const view = selected orelse return error.CompanyViewRequired;
        const candidate = request.candidate orelse return error.MissingContent;
        if (candidate.len == 0 or candidate.len > 32768) return error.InvalidCompanyCandidate;
        var retained_proposal = false;
        for (try manager.taskHistory(view.task, revision_id)) |raw| {
            const row = try parse(alloc, raw);
            if (!std.mem.eql(u8, model.text(row, "kind"), "company_proposal")) continue;
            const value = model.field(row, "value") orelse continue;
            if (std.mem.eql(u8, model.text(value, "operation"), request.operation)) retained_proposal = true;
        }
        if (retained_proposal) {
            const job = try manager.queueReview(view.task);
            if (!std.mem.eql(u8, job.candidate_hash, try workspace.hash(alloc, candidate))) return error.CompanyOperationConflict;
            return encode(alloc, .{ .view = view.view.id, .candidate_revision = request.revision, .job = job.id, .state = if (grant.human_approval) "approval_required" else "verification_pending", .revision = try manager.currentRevision(view.task) });
        }
        if (request.revision == null or !std.mem.eql(u8, request.revision.?, revision_id)) return error.WorkspaceRevisionChanged;
        const integrated = try manager.refresh(view.task);
        try manager.record(integrated, "company_proposal", .{ .actor = grant.actor, .grant = grant.id, .candidate_revision = revision_id, .operation = request.operation });
        try manager.record(integrated, "review_candidate", .{ .text = candidate, .at_ms = io.milliTimestamp() });
        try manager.record(integrated, "review_failure", .{ .code = "IndependentCompanyReviewRequired", .at_ms = io.milliTimestamp() + 1 });
        _ = try manager.checkpoint(integrated);
        const job = try manager.queueReview(integrated);
        return encode(alloc, .{ .view = view.view.id, .candidate_revision = revision_id, .job = job.id, .state = if (grant.human_approval) "approval_required" else "verification_pending", .revision = try manager.currentRevision(view.task) });
    }
    if (request.action == .discover or request.action == .read or request.action == .export_scope) {
        const pinned = request.revision orelse revision_id;
        // Check ancestry before looking up caller-supplied identities so the
        // response cannot reveal whether another private draft exists.
        if (!try manager.companyReadableRevision(if (selected) |view| view.task else null, pinned)) return error.CompanyAccessDenied;
        const manifest = try records.decode(workspace.Manifest, alloc, try manager.contentAt("workspace.json", pinned), .{});
        if (!std.mem.eql(u8, manifest.id, current.workspace)) return error.WorkspaceIdentityMismatch;
        if (request.action == .read) {
            const path = request.path orelse return error.MissingPath;
            if (!authority.permitsPath(grant, path)) return error.CompanyAccessDenied;
            const bytes = try manager.contentAt(path, pinned);
            if (request.limit == 0 or request.limit > 16384 or request.offset > bytes.len) return error.InvalidEvidenceOffset;
            const end = request.offset + @min(request.limit, bytes.len - request.offset);
            const segment = bytes[request.offset..end];
            const encoded = try alloc.alloc(u8, std.base64.standard.Encoder.calcSize(segment.len));
            return encode(alloc, .{ .revision = pinned, .path = path, .offset = request.offset, .content = std.base64.standard.Encoder.encode(encoded, segment), .encoding = "base64", .bytes = bytes.len, .sha256 = try workspace.hash(alloc, bytes), .next_offset = if (end < bytes.len) @as(?usize, end) else null });
        }
        var files: std.ArrayList(std.json.Value) = .empty;
        var count: usize = 0;
        for (try manager.inventory(pinned)) |path| {
            if (!authority.permitsPath(grant, path)) continue;
            if (count >= request.offset and files.items.len < 32) {
                const bytes = try manager.contentAt(path, pinned);
                try files.append(alloc, try parse(alloc, try encode(alloc, .{ .path = path, .sha256 = try workspace.hash(alloc, bytes), .bytes = bytes.len })));
            }
            count += 1;
        }
        return encode(alloc, .{ .version = if (request.action == .export_scope) "omos.scoped-export/v1" else "omos.scoped-inventory/v1", .workspace = current.workspace, .revision = pinned, .actor = grant.actor, .grant = grant.id, .files = files.items, .next_offset = if (request.offset + files.items.len < count) @as(?usize, request.offset + files.items.len) else null, .total = count, .content_endpoint = "/v1/company", .external_dependencies = &[_][]const u8{}, .authority = "content_only" });
    }
    return error.UnsupportedCompanyApi;
}
