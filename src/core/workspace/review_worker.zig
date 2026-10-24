//! Server-side verification of retained candidates. This worker has no actor
//! executor; unfinished work is reported without replaying original actions.
const std = @import("std");
const workspace = @import("fossil_workspace.zig");
const managed = @import("managed_task.zig");
const jobs = @import("review_job.zig");
const review = @import("../agent/runtime/completion_review.zig");
const streams = @import("../agent/stream_provider.zig");
const types = @import("../shared/types.zig");
const provider_id = @import("../config/model_provider.zig");
const io = @import("../shared/io.zig");

pub const Model = struct {
    provider: streams.Provider,
    provider_id: provider_id.ProviderId,
    credential: types.CredentialLease,
    model: []const u8,
    cancel: *std.atomic.Value(bool),
};

pub fn perform(original: workspace.Manager, job: jobs.Job, model: Model) !void {
    var manager = original;
    manager.expected_revision = null;
    manager.review_fence = .{ .task = job.task, .job = job.id, .generation = job.generation, .owner = job.owner };
    const execution_lease = (try manager.tryTaskExecutionLease(job.task)) orelse return error.WorkspaceExecutionBusy;
    defer execution_lease.release();
    const task = try manager.loadTask(job.task);
    try manager.validateTaskBasis(task);
    try @import("company_reads.zig").validate(manager, task, task.company_reads, try manager.revision(task.parent));
    try @import("company_authority.zig").authorizeTask(manager, task);
    const candidate = (try manager.retainedReviewCandidate(task)) orelse return error.NoRetainedReviewCandidate;
    if (!std.mem.eql(u8, job.candidate_hash, try workspace.hash(manager.alloc, candidate)) or job.contract_version != task.definition.version) return error.StaleWorkContract;
    const definition_hash = if (task.model_basis) |basis| basis.definition_hash else "legacy-contract";
    if (!std.mem.eql(u8, definition_hash, job.definition_hash)) return error.StaleWorkspaceDefinition;
    var turn: managed.Turn = .{ .manager = manager, .task = task };
    const policy = if (task.model_basis) |basis| basis.execution.review else @import("definition.zig").ReviewPolicy.legacy;
    const remaining_ms = @max(1, @as(i64, policy.total_timeout_ms) - @max(0, io.milliTimestamp() - job.started_ms));
    const deadline = std.Io.Clock.Timestamp.fromNow(io.getIo(), .{ .clock = .awake, .raw = .fromMilliseconds(remaining_ms) });
    var previous_progress: ?[]const u8 = null;
    var token_spent: u64 = job.reported_tokens;
    for (0..policy.max_attempts) |_| {
        if (!try manager.beginReviewAttempt(job)) return;
        const evidence = try turn.beforeReview(manager.alloc, &.{});
        try manager.record(task, "review_attempt", .{ .job = job.id, .generation = job.generation, .model = model.model, .policy = policy });
        var delivery: streams.DeliveryCertainty = .init();
        var attempts: streams.AttemptEvidence = .{};
        var context: u8 = 0;
        const attempt_deadline = std.Io.Clock.Timestamp.fromNow(io.getIo(), .{ .clock = .awake, .raw = .fromMilliseconds(policy.attempt_timeout_ms) });
        const result = review.assess(manager.alloc, model.provider, .{
            .prompt = task.definition.objective,
            .original_request = try manager.originalRequest(task),
            .root_user_context = "",
            .candidate = candidate,
            .messages = &.{},
            .definition = task.definition,
            .prior_evidence = evidence,
            .prior_review_pages = turn.prior_review_pages,
            .prior_review_checkpoints = turn.prior_review_checkpoints,
            .amendments = task.amendments,
            .journal = turn.journal(),
            .provider = model.provider_id,
            .policy = policy,
            .token_spent = &token_spent,
            .managed_evidence = true,
            .request = .{
                .credential = model.credential,
                .model = model.model,
                .retry_count = 1,
                .messages = &.{},
                .tool_choice = .required,
                .provider_options = .{},
                .trace_ctx = .{},
                .content_capture_limit = @import("../agent/runtime/work_contract.zig").max_bytes,
                .deadline = if (std.Io.Clock.Timestamp.compare(deadline, .lt, attempt_deadline)) deadline else attempt_deadline,
                .delivery = &delivery,
                .attempt_evidence = &attempts,
                .events = .{ .context = &context, .emit_fn = discard },
                .cancel_flag = model.cancel,
            },
        }) catch |err| {
            try manager.record(task, "review_failure", .{ .at_ms = io.milliTimestamp(), .reason = @errorName(err), .candidate_retained = true });
            if (err != error.ContractReviewPending and err != error.Timeout) return err;
            const progress = try turn.reviewProgress();
            const changed = if (previous_progress) |previous| !std.mem.eql(u8, previous, progress) else true;
            previous_progress = progress;
            if (changed and std.Io.Clock.Timestamp.compare(std.Io.Clock.Timestamp.now(io.getIo(), .awake), .lt, deadline)) continue;
            break;
        };
        try turn.sealReview();
        turn.assessment = result.assessment;
        if (result.decision.disposition == .fulfilled and try turn.sourceAssessmentCurrent(result.assessment)) {
            try turn.publish(candidate);
            return;
        }
        turn.task = try manager.setState(task.id, if (result.decision.disposition == .blocked) .blocked else .paused);
        _ = try manager.checkpoint(turn.task);
        try manager.finishReviewJob(job, if (result.decision.disposition == .blocked) .blocked else .changes_required, result.decision.feedback);
        return;
    }
    turn.task = try manager.setState(task.id, .paused);
    try manager.record(turn.task, "paused_result", .{ .status = "verification_pending", .summary = "Server verification is pending. The candidate answer and inspection progress are retained; no completion has been accepted.", .remaining_contract = turn.task.definition, .candidate_retained = true });
    _ = try manager.checkpoint(turn.task);
    try manager.finishReviewJob(job, .pending, "Verification allowance exhausted. Candidate and evidence inspection remain retained.");
}

fn discard(_: *anyopaque, _: streams.Event) void {}

pub const Executor = struct {
    context: *anyopaque,
    run: *const fn (*anyopaque, workspace.Manager, jobs.Job, *std.atomic.Value(bool)) anyerror!void,
};

pub const Scheduler = struct {
    manager: workspace.Manager,
    executor: Executor,
    stopping: std.atomic.Value(bool) = .init(false),

    pub fn loop(self: *Scheduler) void {
        var owner_bytes: [16]u8 = undefined;
        io.getIo().random(&owner_bytes);
        const owner_text: [32]u8 = std.fmt.bytesToHex(&owner_bytes, .lower);
        while (!self.stopping.load(.acquire)) {
            var arena = std.heap.ArenaAllocator.init(std.heap.c_allocator);
            defer arena.deinit();
            var manager = self.manager;
            manager.alloc = arena.allocator();
            const job = manager.claimReview(&owner_text) catch |err| {
                @import("../shared/debug_trace.zig").logf("workspace", "review scheduler claim failed error={s}", .{@errorName(err)});
                std.Io.sleep(io.getIo(), .fromSeconds(1), .awake) catch {};
                continue;
            };
            if (job) |claimed| {
                self.executor.run(self.executor.context, manager, claimed, &self.stopping) catch |err| {
                    manager.finishReviewJob(claimed, if (err == error.Cancelled or err == error.WorkspaceExecutionBusy) .queued else if (err == error.CompanyApprovalRequired or err == error.CompanyApprovalDenied or err == error.CompanyApprovalExpired or err == error.CompanyApprovalStale) .blocked else if (err == error.StaleWorkContract or err == error.StaleWorkspaceDefinition or err == error.WorkspaceReadDependencyChanged or err == error.CompanyReconciliationRequired) .changes_required else .failed, @errorName(err)) catch {};
                };
            } else std.Io.sleep(io.getIo(), .fromSeconds(1), .awake) catch {};
        }
    }
};
