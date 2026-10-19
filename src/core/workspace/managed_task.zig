//! CLI-only adapter between the agent turn and the portable workspace.
const std = @import("std");
const workspace = @import("fossil_workspace.zig");
const types = @import("../shared/types.zig");
const review = @import("../agent/runtime/completion_review.zig");

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

    pub fn begin(alloc: std.mem.Allocator, session: []const u8, parent_session: ?[]const u8, project: []const u8, prompt: []const u8) !?Turn {
        const manager = (try workspace.Manager.bound(alloc)) orelse return null;
        const parent = if (parent_session) |id| try manager.active(id) else null;
        var task = if (try manager.active(session)) |active| active else try manager.start(session, project, prompt, parent);
        if (!std.mem.eql(u8, project, task.project_root)) return error.TaskProjectMismatch;
        var turn: Turn = .{ .manager = manager, .task = task };
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
        if (std.ascii.eqlIgnoreCase(std.mem.trim(u8, prompt, " \t\r\n"), "continue")) turn.review_only_candidate = try manager.failedReviewCandidate(turn.task);
        if (parent_session == null and !std.mem.eql(u8, prompt, task.definition.objective)) {
            turn.task = try manager.amend(task, prompt);
        }
        try manager.record(turn.task, "user_request", .{ .text = prompt, .origin = if (parent_session == null) "user" else "delegation" });
        _ = try manager.checkpoint(turn.task);
        return turn;
    }

    pub fn progress(self: *Turn, alloc: std.mem.Allocator, messages: []const types.ChatMessage) !void {
        const evidence = try review.collectToolEvidence(alloc, messages);
        const coding = if (self.task.model_basis) |basis| if (basis.capability) |id| std.mem.eql(u8, id, "coding_task") else false else false;
        const source = if (coding) try @import("source_state.zig").fingerprint(alloc, self.task.project_root, self.manager.repository) else null;
        for (evidence) |record| {
            const observed = for (self.recorded_evidence.items) |id| {
                if (std.mem.eql(u8, id, record.id)) break true;
            } else false;
            if (observed) continue;
            try self.manager.record(self.task, "tool_evidence", &[_]review.Evidence{record});
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
                if (message.content) |content| self.task = try self.manager.amend(self.task, content);
            }
        }
    }

    pub fn beforeReview(self: *Turn, alloc: std.mem.Allocator, messages: []const types.ChatMessage) ![]const review.Evidence {
        try self.progress(alloc, messages);
        self.reviewed_revision = try self.manager.checkpoint(self.task);
        var evidence: std.ArrayList(review.Evidence) = .empty;
        var pages: std.ArrayList([]const u8) = .empty;
        var checkpoints: std.ArrayList([]const u8) = .empty;
        for (try self.manager.taskHistory(self.task, self.reviewed_revision.?)) |bytes| {
            const Entry = struct { kind: []const u8, task: []const u8, contract_version: u32, value: std.json.Value };
            const entry = (try std.json.parseFromSlice(Entry, alloc, bytes, .{})).value;
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

    fn recordReview(raw: *anyopaque, kind: []const u8, bytes: []const u8) !void {
        const self: *Turn = @ptrCast(@alignCast(raw));
        try self.manager.record(self.task, kind, .{ .at_ms = @import("../shared/io.zig").milliTimestamp(), .data = bytes });
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
        const assessment = (try std.json.parseFromSlice(@import("../agent/runtime/work_contract.zig").Assessment, self.manager.alloc, bytes, .{})).value;
        for (assessment.obligations) |obligation| {
            if (!std.mem.eql(u8, obligation.id, "coding_validation") or obligation.status != .met) continue;
            var supported = false;
            for (try self.manager.taskHistory(self.task, self.reviewed_revision.?)) |raw| {
                const record = (try std.json.parseFromSlice(std.json.Value, self.manager.alloc, raw, .{})).value;
                const model = @import("definition.zig");
                if (!std.mem.eql(u8, model.text(record, "kind"), "source_validation")) continue;
                const value = model.field(record, "value") orelse continue;
                if (!std.mem.eql(u8, model.text(value, "source"), current)) continue;
                for (obligation.evidence) |id| supported = supported or std.mem.eql(u8, id, model.text(value, "evidence"));
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
        });
        self.task = try self.manager.loadTask(self.task.id);
    }

    pub fn retain(self: *Turn) !void {
        const current = try self.manager.loadTask(self.task.id);
        if (current.state == .active) self.task = try self.manager.setState(current.id, .paused);
        if (current.state != .accepted) _ = try self.manager.checkpoint(self.task);
    }
};
