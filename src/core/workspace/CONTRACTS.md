# Workspace contract authority

The pinned OmniForm declaration defines the workspace's expected data and
operation contracts. Host records establish observed state. Independent
assessment compares those records with the task's acceptance obligations.

## Authority and ownership

| Record | Governing contract | Writer | Verification |
| --- | --- | --- | --- |
| Workspace declaration | Pinned OmniForm standard and native profile | Host proposal activation | Structural, semantic and compatibility validation |
| Execution policy | `omos.execution/v1` | Host activation | Bounded policy fields; automatic changes cannot increase allowances |
| Task | Pinned declaration, policy and original request | Host | Preserved acceptance obligations and contract revision |
| Contract amendment and revision | Authenticated user update and current task | Host and independent planner | Version fence, explicit superseded IDs and preserved unaffected obligations |
| Plan | Parent task and `omos_record_plan` | Host planner | Typed fields and preservation of parent requirements |
| Action intent | `omos_record_action` | Host | Invocation and transcript position qualify provider call IDs; intent is not execution |
| Evidence | `omos_record_evidence` | Host | Typed record and producing action identity |
| Command receipt | `omos.command-receipt/v1` | Host | Known completed process outcome; original output retained |
| Assessment | Task and `omos_record_assessment` | Independent assessor, recorded by host | Identity, obligations, evidence references and inspection coverage |
| Result | Capability operation output | Host | Accepted assessment, current source and verified publication |
| Server review job | `omos_record_review_job` | Host scheduler | Pinned workspace contract, task contract, candidate hash and generation-fenced lease |

Operation schemas are declared in `standard/omos.json`. They describe host
records and do not advertise executable model tools. The native host enforces
permissions, evidence inspection and protected task transitions separately.
Agents can propose plan refinements through typed records. Changing an existing
obligation requires the separate host revision process below. Protected records
cannot be written through typed record APIs.

Existing tasks keep their pinned declaration and execution basis. A missing
review policy uses the legacy eight-call, 60-second, single-attempt policy.
Fresh workspaces explicitly record the current review defaults. A declaration
without the newer record operations uses the legacy adapter; audit reports
these tasks rather than rewriting their history.

## User updates

For model-pinned tasks, an authenticated user update increments the contract
version and marks its requirements for revision. Before the next actor request,
the independent planner identifies affected obligation IDs and proposes their
replacement requirements. The host preserves every unlisted obligation and
the protected `request_` requirements. The planner cannot supersede `coding_`
requirements. When an authenticated update withdraws all coding work, the host
switches the task to `general_task` and removes only its native
`coding_validation` and `coding_summary` requirements. Continuing a task without
an update preserves its capability and requirements.

The `contract_amendment` history record retains the user text and previous
contract. The `contract_revision` record retains the previous and current
contracts, previous and current capabilities, superseded IDs, removed native
requirements, planner summary, and applied amendments. The original
request and all evidence remain available. Earlier assessments cannot accept
the new contract version; the assessor checks retained evidence against the
current requirements and applies authenticated user changes in order.

While revision is pending, the host blocks new actor actions, review jobs, and
publication. A rejected revision retains the update for a later continuation.
Updates received during execution are applied at the next steering boundary;
actions already performed remain in the evidence history.

## Retrieval and derived relationships

`omos_review_evidence` supports `query`, `search`, `related` and `coverage`, in
addition to record listing, byte reads and retained assessments. Exact filters
include record kind, tool, status, action identity, source and obligation.
Search is case-insensitive lexical matching over retained content, arguments
and tool names. It is scoped to the complete pinned review manifest. It is not
an embedding index or a search over other workspaces.

An absent source or relationship remains unknown. The host does not infer
validation coverage from similar command text. Source metadata attached to an
action describes the observed source context; the separate source-validation
check still determines whether validation covers the current files.

Query results project canonical events into OmniForm records. Action-to-evidence
relationships describe host-observed provenance. Evidence-to-assessment
relationships are marked as assessor claims, including claims the host rejected.
Neither kind of relationship establishes completion by itself. Record and
relationship pages are independently bounded to 32 entries and expose their
continuation offsets.

Search previews never establish inspection of omitted bytes. Coverage queries
return exact missing ranges and the payload hash. Complete record citations
still require complete coverage or independently verified segment assessments.
Command receipts establish only the process outcome. A zero exit code alone
does not establish test coverage or a successful external action.

Typed queries return at most 32 records and approximately 64 KiB of record
data per page. Records larger than 8 KiB become references containing the
original path, revision, size and hash. The original records remain available
through bounded reads. Relationship pages have a separate continuation offset.

## Review policy

Fresh workspaces store these settings under `review` in `execution/omos.json`:

```json
{
  "max_calls": 8,
  "reserved_calls": 2,
  "response_timeout_ms": 120000,
  "attempt_timeout_ms": 300000,
  "max_attempts": 3,
  "total_timeout_ms": 900000,
  "max_context_bytes": 524288,
  "max_read_bytes": 16384
}
```

The host withdraws evidence retrieval during reserved calls. Rejected calls
are never executed or aliased. Each response is bounded by both its response
timeout and the remaining attempt allowance. Automatic continuation reuses
retained evidence and stops when inspection stops advancing or the total
allowance expires. Continuing a paused task creates another bounded invocation.

Exhausted verification leaves the task paused with its candidate and review
progress retained. It does not publish the task or return to actor execution.
Other review failures preserve their specific failure diagnostics. Optional
`max_tokens` stops further review after the reported input and output usage
reaches its allowance. Usage is recorded after each response and shared across
automatic attempts. A provider that omits usage cannot satisfy an enabled token
allowance. Reported usage arrives after a request, so this is not an exact
billing ceiling. Monetary limits are unsupported and are rejected as unknown
policy fields.

## Workspace service

`omos fossil serve [PORT] --json` starts a loopback HTTP service for the bound
workspace. It requires `OMOS_WORKSPACE_TOKEN`, with 32 to 1,024 bytes, from the
host environment. The default port is 8765; port 0 requests an available port.
The startup JSON reports the selected port and workspace identity. The token
is not part of the declaration or portable repository.

Requests require `Authorization: Bearer TOKEN`. Browser-origin requests are
rejected. `GET /v1/definition` bootstraps the workspace identity and declaration
basis. `POST /v1/workspace` accepts the `omos_workspace_request` contract:

```json
{
  "version": "omos.workspace-api/v1",
  "workspace": "WORKSPACE_ID",
  "definition_hash": "DEFINITION_HASH",
  "revision": "REVISION",
  "action": "query",
  "entity": "omos_task"
}
```

Actions include definition inspection, typed queries, public content reads and
contract audit. Starting the service with `--write` also allows custom typed
records, plan refinement proposals, declaration proposals and queued verification
of retained answers. It never grants
permission to forge host evidence, activate incompatible definitions or publish
a task directly. Writes check the expected revision under the workspace lease.
The HTTP host supports persistent connections, at most 32 concurrent connection
handlers and at most 100 requests per connection.

`read` accepts an original `path`, byte `offset` and a `limit` of at most 16,384
bytes. Text segments use UTF-8; binary segments use base64 with offsets in the
original bytes. Each response includes the full original size, content hash and
next offset. Reads can name an older revision after verifying that it belongs
to the bound workspace. A historical read does not make old validation current.

`queue_review` requires a task ID and a retained candidate. The host records a
durable job before a worker claims it. `job` returns live status using the task
and job IDs. Workers run independent verification only. They cannot execute
actor tools; a finding of unfinished work returns `changes_required`.

A worker lease carries an owner, generation and expiry. Publication checks the
lease inside the host transaction and records the published job with its
publication receipt. Expired workers cannot publish. A restarted scheduler can
reclaim an expired job, reload inspected evidence and reconcile an interrupted
publication against its original receipt. Native actor execution cannot race a
queued or running server review of the same task.
The job reserves each review attempt durably before making model calls. Its
start time, consumed attempts and reported usage survive worker replacement.
An explicit requeue creates a new allowance epoch while preserving the worker
generation and prior evidence. Restarting the service does not renew an
exhausted allowance.

`omo fossil remote URL [REQUEST.json] --json` uses this API without creating a
local repository. Omitting the request file fetches the definition. HTTP is
restricted to loopback; other endpoints require HTTPS. Redirects are refused.
The client does not automatically retry a mutation after an uncertain outcome.

The current service uses the existing Fossil-backed manager. It supports a
single workspace and host credential, with durable review scheduling. Multi-user
authorization, an independently distributed record backend, sparse source
delivery and server execution of actor sessions require additional profiles and
implementations. They are not implied by the workspace API.

## Audit and migration

`omos fossil audit --json` validates canonical action, evidence and plan records
against their pinned operation contracts. It reports validation issues and
legacy tasks without rewriting them or repeating actions. This is a structural
audit, not a completion assessment.

`omos fossil migrate --contracts --json` creates a verified backup, adds the
native contracts without overwriting company-specific fields or operations,
and adds review defaults when that policy section is missing. Existing explicit
review settings remain intact. Active tasks keep
their original declaration and execution basis. Repeating a current migration
does not create another backup. Older tasks can use the current transport API
while their record writes and assessments retain the older task contract.

Fossil remains authoritative for portable records during this stage. Existing
export, verified-copy restoration and migration retain their ownership. A
future server cutover must preserve record identities, content hashes, review
progress and publication receipts, use a single authoritative writer, and
reconcile any records created after cutover before rollback.
