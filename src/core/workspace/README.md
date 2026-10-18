# Managed omos workspaces

Git owns project source. The bound Fossil repository owns saved task contracts,
memory, skills, artifacts, execution evidence, and publication receipts. Native
`omos` and `omo` turns use the same workspace binding.

Completion review receives a bounded evidence manifest. Larger records remain
available through the assessor's read-only `omos_review_evidence` interface.
Its read action returns UTF-8 byte slices of JSON containing the original
arguments and content. The assessor must inspect every byte of a cited record
before that record can establish a met obligation. Pagination never grants
permission to execute an action.

A review attempt permits at most eight auxiliary model calls under one deadline.
Exhausting the review budget retains the answer, evidence, and review records.
Continuing a task with a retained failed-review candidate starts with verification.
The actor resumes only when assessment identifies useful remaining work.

The host records review requests, evidence accesses, assessments, and failures.
These records describe observable decisions. Provider replay state and private
model reasoning remain outside the portable workspace. Review audit records are
checkpointed before publication, with a fence against changes to the reviewed
branch.

`fossil_workspace` supports `verify_manifest` with a workspace-relative `path`.
The referenced JSON has a `files` array whose entries contain `path`, `sha256`,
and `bytes`. The host verifies every listed file against one pinned revision
and returns a bounded receipt. This establishes consistency with the supplied
manifest. Source provenance and external effects require their own evidence.

Configured-provider responses with invalid tool names are rejected before tool
execution. The runtime records a bounded name diagnostic and the advertised
tool identities, then permits one corrected response. Repeated rejection pauses
the turn. Earlier successful actions remain retained.
