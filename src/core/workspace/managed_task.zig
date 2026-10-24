//! CLI-only adapter between the agent turn and the portable workspace.
const std = @import("std");
const workspace = @import("fossil_workspace.zig");
const types = @import("../shared/types.zig");
const review = @import("../agent/runtime/completion_review.zig");
const record_json = @import("../shared/record_json.zig");

pub const Turn = struct {
    manager: workspace.Manager,
    task: workspace.Task,
    reviewed_revision: ?[]const u8 = null,
    assessment: []const u8 = "",
    review_snapshot: []const u8 = "",
    recovered_candidate: ?[]const u8 = null,
    review_only_candidate: ?[]const u8 = null,
    source_basis: ?[]const u8 = null,
    prior_review_pages: []const []const u8 = &.{},
    prior_review_checkpoints: []const []const u8 = &.{},
    recorded_evidence: std.ArrayList([]const u8) = .empty,
    invocation_id: ?[]const u8 = null,
    assessment_record: ?[]const u8 = null,
    filesystem_view: bool = false,

    pub fn begin(alloc: std.mem.Allocator, session: []const u8, parent_session: ?[]const u8, project: []const u8, prompt: []const u8) !?Turn {
        const manager = try workspace.Manager.ensureBound(alloc);
        const parent = if (parent_session) |id| try manager.active(id) else null;
        var task = if (try manager.active(session)) |active| active else try manager.start(session, project, prompt, parent);
        if (task.authority != null) return error.CompanyExecutionIsolationRequired;
        if (!std.mem.eql(u8, project, task.project_root)) return error.TaskProjectMismatch;
        try manager.validateTaskBasis(task);
        var turn: Turn = .{ .manager = manager, .task = task };
        var invocation: [16]u8 = undefined;
        @import("../shared/io.zig").getIo().random(&invocation);
        turn.invocation_id = try workspace.hash(alloc, &invocation);
        if (task.state == .publication_pending or (task.state == .accepted and try manager.publicationPending(task))) {
            const steering = parent_session == null and !std.ascii.eqlIgnoreCase(std.mem.trim(u8, prompt, " \t\r\n"), "continue") and !std.mem.eql(u8, prompt, task.definition.objective);
            if (steering) {
                if (try manager.publicationCommitted(task)) {
                    _ = try manager.retryPublication(task);
                    try manager.acknowledge(task);
                    task = try manager.start(session, project, prompt, parent);
                } else {
                    task = try manager.reopenUnpublished(task);
                }
            } else {
                turn.recovered_candidate = try manager.pendingCandidate(task);
                _ = (try manager.retryPublication(task)) orelse return error.WorkspaceRecoveryRequired;
                turn.task = try manager.loadTask(task.id);
                return turn;
            }
        }
        if (task.state == .conflict) return error.WorkspaceMergeConflict;
        if (task.state == .accepted) task = try manager.start(session, project, prompt, parent);
        turn.task = try manager.setState(task.id, .active);
        if (std.ascii.eqlIgnoreCase(std.mem.trim(u8, prompt, " \t\r\n"), "continue")) turn.review_only_candidate = try manager.retainedReviewCandidate(turn.task);
        if (parent_session == null and !std.mem.eql(u8, prompt, task.definition.objective)) {
            turn.task = try manager.amend(task, prompt);
        }
        try manager.record(turn.task, "user_request", .{ .text = prompt, .origin = if (parent_session == null) "user" else "delegation" });
        _ = try manager.checkpoint(turn.task);
        try @import("filesystem_projection.zig").prepare(manager, turn.task);
        turn.filesystem_view = true;
        return turn;
    }

    // Checkpoints and reviews share these retained-evidence traversal paths.
    pub noinline fn progress(self: *Turn, alloc: std.mem.Allocator, messages: []const types.ChatMessage) !void {
        const latest = try self.manager.loadTask(self.task.id);
        if (latest.definition.version != self.task.definition.version) self.invalidateAssessment();
        self.task = latest;
        if (self.filesystem_view) {
            var scratch = std.heap.ArenaAllocator.init(std.heap.c_allocator);
            defer scratch.deinit();
            var projection_manager = self.manager;
            projection_manager.alloc = scratch.allocator();
            if (try @import("filesystem_projection.zig").checkpoint(projection_manager, self.task)) self.invalidateAssessment();
            try @import("filesystem_projection.zig").prepare(projection_manager, self.task);
        }
        const evidence = try review.collectToolEvidence(alloc, messages);
        const coding = if (self.task.model_basis) |basis| if (basis.capability) |id| std.mem.eql(u8, id, "coding_task") else false else false;
        const source = if (coding) try @import("source_state.zig").fingerprint(alloc, self.task.project_root, self.manager.repository) else null;
        for (evidence) |original_record| {
            var record = original_record;
            if (self.invocation_id) |invocation| if (record.assistant_index) |index| if (record.raw_call_id) |id| {
                record.action_id = try actionIdentity(alloc, invocation, index, id);
                record.id = try alloc.print("execution:{s}:{s}", .{ record.action_id.?, record.id });
            };
            record.source = source;
            const observed = for (self.recorded_evidence.items) |id| {
                if (std.mem.eql(u8, id, record.id)) break true;
            } else false;
            if (observed) continue;
            try self.manager.record(self.task, "tool_evidence", &[_]review.Evidence{record});
            if (try @import("evidence_receipt.zig").derive(alloc, record)) |receipt| try self.manager.record(self.task, "command_receipt", receipt);
            if (source) |current| if (self.source_basis) |previous| {
                if (record.status == .success and record.tool != null and (std.mem.eql(u8, record.tool.?, "shell") or std.mem.eql(u8, record.tool.?, "shell_input")) and std.mem.eql(u8, current, previous)) {
                    try self.manager.record(self.task, "source_validation", .{ .evidence = record.id, .source = current });
                }
            };
            try self.recorded_evidence.append(alloc, record.id);
        }
        self.source_basis = source;
        // User corrections are authenticated by the runtime's message origin.
        for (messages) |message| {
            if (message.role == .user and (message.context_origin == .user_turn or message.restored_steering)) {
                if (message.content) |content| {
                    const previous_version = self.task.definition.version;
                    self.task = try self.manager.amend(self.task, content);
                    if (self.task.definition.version != previous_version) self.invalidateAssessment();
                }
            }
        }
        _ = try self.manager.checkpoint(self.task);
    }

    fn invalidateAssessment(self: *Turn) void {
        self.reviewed_revision = null;
        self.assessment = "";
        self.assessment_record = null;
        self.review_snapshot = "";
        self.review_only_candidate = null;
        self.prior_review_pages = &.{};
        self.prior_review_checkpoints = &.{};
    }

    pub noinline fn beforeReview(self: *Turn, alloc: std.mem.Allocator, messages: []const types.ChatMessage) ![]const review.Evidence {
        try self.progress(alloc, messages);
        if (self.task.revision_pending) return error.TaskContractRevisionPending;
        self.reviewed_revision = try self.manager.checkpoint(self.task);
        var evidence: std.ArrayList(review.Evidence) = .empty;
        var pages: std.ArrayList([]const u8) = .empty;
        var checkpoints: std.ArrayList([]const u8) = .empty;
        if (self.task.authority != null) {
            const prefix = try alloc.print("company/checkpoints/{s}/", .{self.task.id});
            for (try self.manager.inventory(self.reviewed_revision.?)) |path| {
                if (!std.mem.startsWith(u8, path, prefix)) continue;
                const bytes = try self.manager.contentAt(path, self.reviewed_revision.?);
                try evidence.append(alloc, .{ .id = try alloc.print("workspace-checkpoint:{s}", .{try workspace.hash(alloc, bytes)}), .kind = .verification, .status = .success, .content = bytes });
            }
        }
        for (try self.manager.taskHistory(self.task, self.reviewed_revision.?)) |bytes| {
            const Entry = struct { kind: []const u8, task: []const u8, contract_version: u32, value: std.json.Value };
            const entry = (try std.json.parseFromSlice(Entry, alloc, bytes, .{ .ignore_unknown_fields = true })).value;
            if (std.mem.eql(u8, entry.kind, "command_receipt") or std.mem.eql(u8, entry.kind, "ui_source_validation")) {
                const content = try std.json.Stringify.valueAlloc(alloc, entry.value, .{});
                try evidence.append(alloc, .{
                    .id = try alloc.print("command-receipt:{s}", .{try workspace.hash(alloc, content)}),
                    .kind = .verification,
                    .content = content,
                    .status = if (std.mem.eql(u8, @import("definition.zig").text(entry.value, "outcome"), "failed") or std.mem.eql(u8, @import("definition.zig").text(entry.value, "status"), "failed")) .failure else if (std.mem.eql(u8, entry.kind, "ui_source_validation") and std.mem.eql(u8, @import("definition.zig").text(entry.value, "status"), "passed")) .success else null,
                    .action_id = @import("definition.zig").text(entry.value, "action_id"),
                    .source = @import("definition.zig").text(entry.value, "source"),
                });
            }
            if (std.mem.eql(u8, entry.kind, "review_evidence_page") and entry.contract_version == self.task.definition.version) {
                if (entry.value == .object) if (entry.value.object.get("data")) |data| if (data == .string) try pages.append(alloc, data.string);
            }
            if (std.mem.eql(u8, entry.kind, "review_segment_assessment") and entry.contract_version == self.task.definition.version) {
                if (entry.value == .object) if (entry.value.object.get("data")) |data| if (data == .string) try checkpoints.append(alloc, data.string);
            }
            if (!std.mem.eql(u8, entry.kind, "tool_evidence")) continue;
            const records = (try std.json.parseFromValue([]review.Evidence, alloc, entry.value, .{})).value;
            for (records) |record| {
                const present = for (evidence.items) |existing| {
                    if (std.mem.eql(u8, record.id, existing.id)) break true;
                } else false;
                if (!present) try evidence.append(alloc, record);
            }
        }
        self.prior_review_pages = pages.items;
        self.prior_review_checkpoints = checkpoints.items;
        const inputs = try self.manager.reviewInputs(self.task, self.reviewed_revision.?);
        self.review_snapshot = inputs.snapshot;
        if (self.source_basis) |source| try evidence.append(alloc, .{ .id = try alloc.print("source-state:{s}", .{source}), .kind = .verification, .content = try std.json.Stringify.valueAlloc(alloc, .{ .source_hash = source, .note = "Current source bytes observed by the host; validation requires a matching successful command receipt." }, .{}) });
        try evidence.append(alloc, try review.workspaceEvidence(alloc, self.review_snapshot));
        for (inputs.files) |file| {
            try evidence.append(alloc, .{ .id = try alloc.print("workspace-file:{s}:{s}", .{ file.hash, file.path }), .kind = .workspace, .content = file.content });
        }
        return evidence.toOwnedSlice(alloc);
    }

    pub fn journal(self: *Turn) review.Journal {
        return .{ .context = self, .record_fn = recordReview };
    }

    pub fn actionIdentity(alloc: std.mem.Allocator, invocation: []const u8, assistant_index: usize, call: []const u8) ![]const u8 {
        return alloc.print("{s}:{d}:{s}", .{ invocation, assistant_index, try workspace.hash(alloc, call) });
    }

    /// Only distinct inspected bytes or independent segment findings establish
    /// review progress. Repeated queries and failed verdicts cannot renew budgets.
    pub fn reviewProgress(self: *Turn) ![]const u8 {
        const revision = try self.manager.checkpoint(self.task);
        var identities: std.StringHashMapUnmanaged(void) = .empty;
        for (try self.manager.taskHistory(self.task, revision)) |raw| {
            const model = @import("definition.zig");
            const row = (try std.json.parseFromSlice(std.json.Value, self.manager.alloc, raw, .{})).value;
            const kind = model.text(row, "kind");
            if (!std.mem.eql(u8, kind, "review_evidence_page") and !std.mem.eql(u8, kind, "review_segment_assessment")) continue;
            const version = model.field(row, "contract_version") orelse continue;
            if (version != .integer or version.integer != self.task.definition.version) continue;
            const value = model.field(row, "value") orelse continue;
            const data = model.text(value, "data");
            const page = (std.json.parseFromSlice(std.json.Value, self.manager.alloc, data, .{}) catch continue).value;
            if (std.mem.eql(u8, kind, "review_evidence_page") and model.text(page, "id").len == 0) continue;
            try identities.put(self.manager.alloc, try workspace.hash(self.manager.alloc, data), {});
        }
        // Count distinct immutable pages; repeated identical pages do not advance.
        return self.manager.alloc.print("{d}", .{identities.count()});
    }

    fn recordReview(raw: *anyopaque, kind: []const u8, bytes: []const u8) !void {
        const self: *Turn = @ptrCast(@alignCast(raw));
        const id = try self.manager.recordReceipt(self.task, kind, .{ .at_ms = @import("../shared/io.zig").milliTimestamp(), .data = bytes });
        if (std.mem.eql(u8, kind, "review_assessment")) self.assessment_record = id;
    }

    pub fn sealReview(self: *Turn) !void {
        // Only the host's audit journal may have advanced during assessment.
        // Fence actual branch edits before adding those audit records.
        const previous = self.reviewed_revision orelse return error.WorkspaceReviewRequired;
        if (!std.mem.eql(u8, previous, try self.manager.currentRevision(self.task))) return error.WorkspaceRevisionChanged;
        self.reviewed_revision = try self.manager.checkpoint(self.task);
        var snapshot = (try std.json.parseFromSlice(std.json.Value, self.manager.alloc, self.review_snapshot, .{})).value;
        try snapshot.object.put(self.manager.alloc, "reviewed_revision", .{ .string = self.reviewed_revision.? });
        self.review_snapshot = try std.json.Stringify.valueAlloc(self.manager.alloc, snapshot, .{});
    }

    pub fn sourceAssessmentCurrent(self: *Turn, bytes: []const u8) !bool {
        const basis = self.task.model_basis orelse return true;
        if (basis.capability == null or !std.mem.eql(u8, basis.capability.?, "coding_task")) return true;
        const current = try @import("source_state.zig").fingerprint(self.manager.alloc, self.task.project_root, self.manager.repository);
        const history = try self.manager.taskHistory(self.task, self.reviewed_revision.?);
        const assessment = try record_json.decode(@import("../agent/runtime/work_contract.zig").Assessment, self.manager.alloc, bytes, .{});
        for (assessment.obligations) |obligation| {
            if (!std.mem.eql(u8, obligation.id, "coding_validation") or obligation.status != .met) continue;
            var supported = false;
            for (history) |raw| {
                const record = (try std.json.parseFromSlice(std.json.Value, self.manager.alloc, raw, .{})).value;
                const model = @import("definition.zig");
                if (!std.mem.eql(u8, model.text(record, "kind"), "source_validation")) continue;
                const value = model.field(record, "value") orelse continue;
                if (!std.mem.eql(u8, model.text(value, "source"), current)) continue;
                for (obligation.evidence) |id| {
                    if (std.mem.eql(u8, id, model.text(value, "evidence"))) {
                        supported = true;
                        continue;
                    }
                    for (history) |receipt_raw| {
                        const receipt_row = (try std.json.parseFromSlice(std.json.Value, self.manager.alloc, receipt_raw, .{})).value;
                        if (!std.mem.eql(u8, model.text(receipt_row, "kind"), "command_receipt")) continue;
                        const receipt = model.field(receipt_row, "value") orelse continue;
                        if (!std.mem.eql(u8, model.text(receipt, "outcome"), "succeeded") or !std.mem.eql(u8, model.text(receipt, "evidence_id"), model.text(value, "evidence"))) continue;
                        const content = try std.json.Stringify.valueAlloc(self.manager.alloc, receipt, .{});
                        const reference = try self.manager.alloc.print("command-receipt:{s}", .{try workspace.hash(self.manager.alloc, content)});
                        if (std.mem.eql(u8, id, reference)) supported = true;
                    }
                }
            }
            if (!supported) return false;
        }
        return true;
    }

    pub fn publish(self: *Turn, candidate: []const u8) !void {
        _ = try self.manager.publish(self.task, .{
            .task_id = self.task.id,
            .revision = self.reviewed_revision orelse return error.WorkspaceReviewRequired,
            .contract_version = self.task.definition.version,
            .disposition = "fulfilled",
            .candidate = candidate,
            .assessment = self.assessment,
            .workspace_snapshot = self.review_snapshot,
            .assessment_record = self.assessment_record,
        });
        self.task = try self.manager.loadTask(self.task.id);
    }

    pub fn retain(self: *Turn) !void {
        const current = try self.manager.loadTask(self.task.id);
        if (current.state == .active) self.task = try self.manager.setState(current.id, .paused);
        if (current.state != .accepted and current.state != .publication_pending) {
            if (self.filesystem_view) _ = try @import("filesystem_projection.zig").checkpoint(self.manager, current);
            _ = try self.manager.checkpoint(self.task);
        }
    }
};
