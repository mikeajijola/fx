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

When a record exceeds one review attempt, the assessor uses
`omos_review_checkpoint` to record decisions about contiguous inspected bytes.
Each segment identifies the obligations it supports, contradicts, or does not
address. The host binds these decisions to the exact payload hash, byte range,
and contract version. Resumption restores their verified coverage and continues
at the next byte without resending every earlier page. Changed evidence or
contracts invalidate the affected decisions. Raw page cursors alone never
establish inspection, and contradictory segment decisions prevent acceptance
based on those checkpoints.

The initial manifest lists 16 evidence records. Further records remain available
through the evidence interface's `list` action. Its `assessments` action retrieves
retained segment decisions by evidence ID. Large requests and steering are also
retrievable records; completion requires inspection of their omitted contents.

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
execution. The runtime distinguishes missing, malformed, and unadvertised names
from invalid outgoing definitions. It records bounded diagnostics and the
advertised tool identities, then permits one corrected response when effects are
known to be absent. Possible provider effects use the existing reconciliation
path before any retry. Repeated rejection pauses the turn. Earlier successful
actions remain retained.

## Declare the workspace model

New workspaces contain `omniform/company.json` and `execution/omos.json`.
The company declaration uses the same pinned OmniForm schema and semantic
extension as the SaaS model. The native profile is `omos.workspace/v1`.
The files under `standard/` record the upstream version, license and provenance.
The binary validates declarations itself; JavaScript and Ajv are test tools.
The [contract authority reference](CONTRACTS.md) describes record schemas,
review policy, derived relationships, auditing and the workspace service.

Inspect or validate the model with either CLI name:

```bash
omos fossil definition show --json
omo fossil definition validate company.json --json
omos fossil definition propose company.json --json
omos fossil definition propose company.json --execution execution.json --json
omos fossil query omos_task --json
omo fossil query omos_task --offset 32 --json
```

The JSON snapshot exposes model results in `model_data`. Validation reports
include `valid`, `errors`, the native profile, the pinned standard version and,
when valid, the canonical declaration hash. Semantic scopes describe data relationships
and discovery metadata in this single-user host; they do not create user roles
or grant tool permissions. Unknown policy features, unsupported
JSON Schema keywords, secret literal fields, Git-specific governance and
required operation approvals are rejected. A declaration cannot grant tool
permissions or install executable implementations.

A proposal receives a separate Fossil branch. The host validates structural
and semantic references and compares the candidate with the active declaration.
Existing capabilities, operations, realisations and resources retain their
contracts. Existing entity fields keep their types and required status. New
entities and optional fields can be added. Compatible proposals activate for
future tasks after the host publishes a compatibility receipt. Incompatible
proposals remain inactive and retained. A task always uses the declaration
revision, canonical hash and execution policy saved when it started.

The `general_task` and `coding_task` capabilities bind to the native task
runtime. Capability discovery reports these bindings alongside installed skills
and configured MCP tools. Other declared capabilities remain `declared_only`
until the host has an implementation. An exact MCP server filter continues to
search that server only. Operation input/output schemas describe the company
contract; they do not create new executable tool names.

`fossil_workspace` adds these actions:

| Action | Input | Result |
| --- | --- | --- |
| `definition` | None | The task's pinned declaration and execution basis |
| `query` | Optional `entity` and `offset` | A page of records with source revision and next offset |
| `record` | `entity`, JSON string in `content` | A validated custom entity record or proposed plan refinement |
| `propose_definition` | Declaration JSON string in `content`, optional execution JSON string in `execution` | Host compatibility decision and retained proposal |

Task contracts, actions, evidence, assessments and results project from existing
canonical files and history. Memory, skills and artifacts retain their existing
paths. Custom records are content addressed under `records/`. Agents cannot
write host-owned entity types. An `omos_plan` write records a refinement proposal;
it cannot replace a host contract or remove an obligation. Indexes and query
results are derived from canonical records and are not another editable source.

## Plan and bound an invocation

Before the first actor call of a modeled task, a separate read-only planner
selects a native capability and derives checkable obligations. The host retains
`request_complete` and adds validation and final-answer obligations for coding.
Repository checks must follow applicable repository instructions. Commits and
remote publication are required only when requested or required by those
instructions. Planning and assessment cannot execute tools.

The execution policy defaults to a progress check after every four completed
tool batches, a pause after three consecutive stalled checks, and at most 100
actor steps per invocation. The last actor slot is reserved for a summary with
tools disabled. The existing global agent-step limit still applies. Continuing
a paused task starts another bounded invocation with the same contract and
retained evidence.

Progress assessment records successful evidence, remaining obligation IDs and
a reason to continue, finalize or pause. New call IDs and repeated identical
results cannot establish fresh progress. Finalize requests a candidate answer;
the normal completion assessment and verified publication remain required.
Pause retains a partial result and leaves the task unaccepted.

Start coding tasks in the repository they change. A scan that stops at a nested
repository cannot establish a source basis. Coding validation is associated
with a hash of the repository files exposed by the native indexer. The hash
includes paths, file types, permissions, contents, and symbolic-link targets.
A command must run across an unchanged source state to
provide current validation evidence. A later source edit invalidates that basis.
Incomplete scans, unreadable or oversized files cannot establish validation.
Generated files should follow the repository's ignore rules; changes to visible
generated files also change the source basis.

## Migrate an existing workspace

```bash
omos fossil migrate --json
omos fossil verify
```

Migration creates a verified `.pre-omniform-<timestamp>.fossil` backup before
writing the model and workspace format 2. Repeating migration preserves the
active declaration. Existing task branches, original requests, amendments,
contracts, evidence and publication receipts remain intact. Existing tasks use
the legacy adapter; future root tasks pin the model. Older binaries reject
format 2 rather than silently writing it.

To inspect or restore an exported workspace, bind its verified clone with
`omos fossil use PATH`. Profile credentials, browser sessions and opaque runtime
checkpoints remain outside the portable repository. Migration and recovery do
not replay completed external actions.
