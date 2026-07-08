# Workspace Materialization Runbook

How the Software Factory materializes a trustworthy workspace for a run —
binding an operator-approved local folder or checking out a GitHub repository —
and how unavailable or unsafe source inputs are made explicit instead of being
silently "read".

## What materialization is (and is not)

Materialization turns a run's source input (`localFolder` / `githubRepo` on
`run.created`) into a real, bounded workspace BEFORE any worker mutates files.
It is:

- **ledger-first** — every step is a `workspace.*` event replayed by
  `projectWorkspace` (`@software-factory/worker`); there is no workspace state
  outside the ledger,
- **separate from execution** — it is triggered/retried through its own
  surface (`POST /api/runs/:id/workspace`), so setup failures can be inspected
  and fixed without touching the execution path (U5/U6 consume the projected
  workspace), and
- **fail-closed** — a source that cannot back a workspace on this runtime is
  recorded as `workspace.unavailable` with a `requiredAction`; the factory
  never pretends.

Prompt/PRD-only runs have no source workspace to materialize; they receive a
fresh generated workspace when execution starts (U5/U6).

## Event families

| Event                          | Meaning                                                                    |
| ------------------------------ | -------------------------------------------------------------------------- |
| `workspace.local_bound`        | Local folder bound (resolved path, boundary rule, dirty-state policy)      |
| `workspace.checkout_started`   | Repo checkout attempt started (repo, requested branch, path, attempt #)   |
| `workspace.ref_resolved`       | Branch + commit resolved for the checkout (evidence)                       |
| `workspace.checkout_completed` | Checkout complete (repo, branch, commit, checkout path, dirty policy)     |
| `workspace.checkout_failed`    | Checkout attempt failed — sanitized reason, retryable                      |
| `workspace.unavailable`        | The source cannot back a workspace on this runtime — `requiredAction` set  |

Boundary/traversal rejections additionally record `security.block` (the same
fail-closed class as sandbox path escapes). See
[failure-taxonomy.md](./failure-taxonomy.md) for severities and rescue actions.

## Runtime source rules

### Local runtime

Local folders are admitted ONLY when they resolve inside:

1. the **approved working boundary** (`SF_WORKSPACE_BOUNDARY`, default: the
   workspace root that owns the factory dir), or
2. an **explicitly chosen operator folder**
   (`SF_WORKSPACE_APPROVED_FOLDERS`, comma-separated absolute paths).

`..` traversal, absolute escapes, and other drive letters are rejected —
never followed — with `security.block` + `workspace.unavailable` evidence. The
containment check is Windows-safe (drive letters, backslashes, case-insensitive
drive comparison).

### Cloud runtime (KTD5)

Cloud runs **never read laptop paths**. A local-only folder records
`workspace.unavailable` with the alternatives; a cloud workspace requires a
GitHub repository checkout, uploaded PRD text, or a future upload/sync input.
When both a folder and a repo are supplied, the repo backs the workspace.

### Repository checkouts (local + cloud)

`githubRepo` accepts `owner/repo`, an `https://github.com/...` URL, or the ssh
form. Checkouts are shallow (`--depth 1`, optionally `--branch`), land under
`SF_WORKSPACE_CHECKOUT_ROOT` (default `<factoryDir>/workspaces/<runId>`), and
record **repo, branch, commit, checkout path, and dirty-state policy**
(`clean_checkout` for a fresh clone) as evidence.

## Credential separation (hardening E5)

Source checkout credentials are a **separate setup surface** from deploy and
research credentials:

- `SF_GIT_CHECKOUT_TOKEN` — source checkout (this runbook),
- `RENDER_API_KEY` / GitHub destination — deploy ([render-deployment.md](./render-deployment.md)),
- `SF_RESEARCH_SEARCH_API_KEY` — research providers ([research.md](./research.md)).

Only credential **presence** ever reaches config, `GET /api/setup`, or
evidence. The token value is read at exec time by the checkout client, spliced
into the clone URL for the child process only, and stripped from every error
message (`sanitizeCheckoutDetail`) before it can reach the ledger. Userinfo
credentials embedded in a supplied repo URL are discarded during parsing.

## Operator surface

```bash
# Inspect the materialization rules for this runtime
curl "$SF_BASE_URL/api/setup"            # -> workspace.materialization

# Materialize (or retry) the workspace for a run
curl -X POST "$SF_BASE_URL/api/runs/<runId>/workspace" \
  -H "x-operator-token: $SF_OPERATOR_TOKEN" \
  -H "content-type: application/json" \
  -d '{"branch":"main"}'

# Inspect the projected workspace state
curl "$SF_BASE_URL/api/runs/<runId>/workspace"
```

The trigger is command-guarded (operator token, origin/CSRF, stale-version)
like every other mutating route.

## Retry semantics (state converges)

- A **ready** workspace for the same source is reused — a retry returns the
  existing state (`converged: true`) and appends nothing.
- An **unchanged unavailable** setup dedups onto the same single
  `workspace.unavailable` event (idempotency-keyed on the material facts).
- A **failed checkout** retried after a setup fix starts a NEW attempt with an
  incremented `attempt` counter; prior evidence is never duplicated and the
  projection converges on the latest outcome.

## Downstream consumers

- **Research (U2)** — a materialized checkout/bound folder is scanned for real
  evidence (`repo_scan` / `local_folder` sources); an un-materialized repo
  keeps reporting "materialize first" instead of fabricating findings.
- **Build contract (U3/X3)** — after a successful materialization the contract
  is re-derived with the workspace evidence (repo, branch, commit, checkout
  path); `contract.generated` is digest-idempotent so it appends only on
  change.
- **Execution (U5/U6)** — the projected workspace (`projectWorkspace`) is the
  seam execution reads for workspace directories and write boundaries.

## Environment variables

| Variable                        | Purpose                                                    | Default                          |
| ------------------------------- | ---------------------------------------------------------- | -------------------------------- |
| `SF_WORKSPACE_BOUNDARY`         | Approved working boundary for local folders                | workspace root owning factoryDir |
| `SF_WORKSPACE_APPROVED_FOLDERS` | Comma-separated explicitly approved operator folders       | (none)                           |
| `SF_WORKSPACE_CHECKOUT_ROOT`    | Root for repository checkouts                              | `<factoryDir>/workspaces`        |
| `SF_WORKSPACE_DIRTY_POLICY`     | `reject` -> `reject_dirty`, anything else -> `allow_dirty` | `allow_dirty`                    |
| `SF_GIT_CHECKOUT_TOKEN`         | Source checkout credential (presence-only in evidence)     | (none)                           |
