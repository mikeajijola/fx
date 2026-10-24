# Run the company service on one host

These files deploy the current signed company gateway and independent review
workers. They do not provide hosted actor isolation, SSO enrollment, or a complete
company reconciliation coordinator. See the supported operations and limits in
[the workspace contracts](../../src/core/workspace/CONTRACTS.md#scoped-company-service).

Use a dedicated service account with persistent home storage. Install the built
`omos` and `omo` aliases and verified Fossil helper for that account using
`scripts/install-omos.sh`. Keep this profile separate from a person's installation.
The service account's configuration selects the review provider and credentials.

## Initialize the empty instance

Run these commands as the service account, after installing its binaries:

```sh
umask 077
mkdir -p "$HOME/.local/share/omos/company" "$HOME/.config/omos"
cd "$HOME/.local/share/omos/company"
"$HOME/.local/bin/omos" fossil ensure --json
printf '%s\n' '{"version":"omos.company-admin/v1","action":"initialize"}' > initialize.json
"$HOME/.local/bin/omos" fossil company initialize.json --json
rm initialize.json
```

`ensure` creates an empty format 2 instance when no binding exists. It preserves
an existing binding and does not import historical sessions. Check its returned
repository path and workspace identity before initialization. Authority is
stored in that repository; issuer secrets remain in the account's protected
profile. Enroll actors with local operator `grant` requests that specify exact
actions, path scopes, public keys, and expiry. Enrollment does not follow from
editing the OmniForm definition.

Create a private environment file for the local owner endpoint:

```sh
printf 'OMOS_WORKSPACE_TOKEN=%s\n' "$(openssl rand -hex 32)" > "$HOME/.config/omos/company.env"
chmod 600 "$HOME/.config/omos/company.env"
```

The bearer token belongs to local administration or a trusted server bridge.
External company actors use their signed, scoped requests instead.

## Start and expose the service

Copy `omos-company.service` into `~/.config/systemd/user/`, then run:

```sh
systemctl --user daemon-reload
systemctl --user enable --now omos-company.service
systemctl --user status omos-company.service
journalctl --user -u omos-company.service
```

Configure account lingering through the host's administrator if this user
service must continue after logout. The gateway listens on loopback port 8765.
`GET http://127.0.0.1:8765/v1/company` must return the initialized workspace,
issuer, epoch, and accepted revision. A running process alone does not prove
authority is active. Test a signed scoped read and proposal before onboarding
users; inspect its durable job outcome and publication receipt.

Use the supplied `Caddyfile` with Caddy on the same host and set
`OMOS_COMPANY_DOMAIN` to the company's configured domain. Caddy manages the TLS
endpoint. Its route exposes only `/v1/company`; the owner bearer interface,
definition endpoint, and repository file remain private. Browser clients need
a server bridge that signs or forwards each authenticated user's scoped
requests. The gateway rejects browser-origin requests directly. Keep the service
on loopback; this configuration does not authorize exposing its other routes.

## Backup and restore

Create a verified portable export with `omos fossil export PATH`. Preserve all
company branches, including authority, views, proposals, and operation outcomes.
Back up issuer material under `~/.fx/authority/`, review provider credentials,
and the private environment file separately using the operator's protected
backup procedure. Plain company exports do not contain those secrets. Fossil
repositories and scoped packages currently contain plaintext content. Use the
host's encrypted storage and protected backup transport where your deployment
requires encryption; object-level encryption and portable key-domain recovery
are not implemented by this service. Current scoped exports can be downloaded as signed, content-addressed file packages with
`omos fossil export-scope`, then verified offline with `omos fossil verify-scope`.
They declare a file snapshot scope; capability dependency closure is not inferred.

Before activating a restored instance on another host, stop and fence the old
host. Bind the verified repository, inspect authority with `company` action
`status`, and explicitly rotate the issuer using that control revision. Rotation
advances the epoch and revokes old grants. Re-enroll actors deliberately. On the
same host, recovery refuses a stale copy and fences the previous repository after
successful activation. These local locks do not provide cross-host consensus.

Company views reuse host mutation and integration checkouts while retaining
separate canonical branches. Personal tasks still use their own native checkouts.
Measure repository size, host checkout size, active view count, review duration,
and storage growth when setting capacity expectations. Sparse projections,
bounded shared caches, and continuous desired-state
reconciliation remain required before treating this deployment as the complete
large-company model.

## Review capacity

New instances store `server.review_workers: 2` in `execution/omos.json`. The
accepted execution policy permits 1–4 workers. Restart the service after an
explicit policy change; existing policies without this field use one worker.
Each task retains its own review allowance and execution lease. Compatible
changes to accepted state trigger reconciliation and fresh assessment within
that allowance, while publication stays behind the coordinated writer boundary.
Conflicts, stale approvals, and exhausted allowances remain recorded outcomes.
