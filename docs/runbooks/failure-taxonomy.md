# Runbook: Failure Taxonomy

Every failure-shaped event the Software Factory core can emit, and the operator
rescue action for each. This runbook is the human companion to the machine
source of truth, `packages/core/src/observability/failure-registry.ts`.

**Kept in sync by a test.** `packages/core/test/observability/failure-registry.test.ts`
asserts that this file has a `### <event.type>` heading for **every** registry
entry and **no** failure headings that are not in the registry — so the registry
and this taxonomy cannot drift. The registry is also proven exhaustive over the
event taxonomy: every event type whose name contains `fail`, `error`, `reject`,
`block`, `invalid`, `cancel`, `dead_letter`, `retry`, `fallback`,
`setup_required`, or `unavailable` must have an entry.

## How to read each class

- **severity** — ledger/alert level: `info | success | warn | error | critical`.
- **blocking** — does it stop the run / pipeline / affected sub-flow from
  progressing? (A paused deploy is blocking for the deploy step but does **not**
  fail the local run.)
- **retryable** — can a bounded retry or a re-run plausibly recover **once the
  cause is addressed**? `false` means a blind retry cannot help — setup, policy,
  or a human fix is required first.
- **rescue** — what the operator does to recover.

## Summary

| Event                       | Severity | Blocking | Retryable |
| --------------------------- | -------- | -------- | --------- |
| `run.failed`                | error    | yes      | yes       |
| `run.cancelled`             | warn     | yes      | yes       |
| `research.failed`           | error    | yes      | yes       |
| `workspace.checkout_failed` | error    | yes      | yes       |
| `workspace.unavailable`     | warn     | yes      | no        |
| `execution.blocked`         | warn     | yes      | no        |
| `execution.failed`          | error    | yes      | yes       |
| `preflight.check_failed`    | warn     | yes      | yes       |
| `preflight.failed`          | error    | yes      | yes       |
| `ticket.dead_lettered`      | error    | yes      | no        |
| `worker.retry`              | warn     | no       | yes       |
| `worker.failed`             | error    | yes      | yes       |
| `worker.cancelled`          | warn     | no       | yes       |
| `adapter.setup_required`    | warn     | yes      | no        |
| `adapter.auth_failed`       | error    | yes      | no        |
| `adapter.error`             | error    | yes      | yes       |
| `sandbox.fallback`          | warn     | no       | no        |
| `sandbox.error`             | error    | yes      | yes       |
| `gate.failed`               | error    | yes      | yes       |
| `repair.failed`             | error    | yes      | no        |
| `preview.failed`            | error    | yes      | yes       |
| `deploy.setup_required`     | warn     | yes      | no        |
| `deploy.config_invalid`     | error    | yes      | yes       |
| `deploy.provider_failed`    | error    | yes      | yes       |
| `deploy.migration_failed`   | error    | yes      | yes       |
| `deploy.health_failed`      | error    | yes      | yes       |
| `security.block`            | critical | yes      | no        |
| `security.command_rejected` | critical | yes      | no        |

## Run + ticket lifecycle failures

### run.failed

**Run failed** · error · blocking · retryable.

The run reached a terminal failure. Open the run, read the `run.failed` reason
and the last failing ticket/gate, fix the cause, then re-create the run. Use
[golden-run-replay.md](./golden-run-replay.md) to replay the ledger and pinpoint
the failure event.

### run.cancelled

**Run cancelled** · warn · blocking · retryable.

The run was cancelled by an operator or supervisor; in-flight workers and
adapters were asked to stop. If the cancellation was unintended, re-create the
run.

### ticket.dead_lettered

**Ticket dead-lettered** · error · blocking · not retryable.

A ticket exhausted its retry budget. Inspect the attached gate/worker evidence,
fix the underlying cause, then re-plan or re-run the ticket — a blind retry will
not help. Downstream tickets that depend on it will show as **blocked by a
failed dependency** in the operator diagnostics.

### worker.retry

**Worker retrying** · warn · non-blocking · retryable.

A transient worker/gate failure triggered a bounded retry; the attempt count is
observable on the ledger. No action is needed unless retries exhaust and the
ticket dead-letters.

### worker.failed

**Worker failed** · error · blocking · retryable.

A worker failed for a ticket. Review the worker reason plus the adapter/gate
evidence. The runner retries within budget; otherwise fix the cause and re-run
the ticket.

### worker.cancelled

**Worker cancelled** · warn · non-blocking · retryable.

A worker was cancelled (the run was cancelled, or a superseded attempt was
stopped). Projections stay consistent; re-run the ticket if the cancellation was
unintended.

## Research failures

### research.failed

**Research failed** · error · blocking · retryable.

The research stage failed before its brief completed (provider timeout, missing
credentials, or budget exhaustion). Partial findings, assumptions, and
unresolved gaps recorded before the failure stay replayable on the ledger —
inspect the `research.failed` reason, fix the cause, then re-run research. A
later `research.brief_completed` resolves this failure. Planning-only mode
remains available without a completed brief.

## Workspace materialization failures

See [workspace-materialization.md](./workspace-materialization.md) for the full
materialization flow, boundary rules, and the checkout-credential surface.

### workspace.checkout_failed

**Workspace checkout failed** · error · blocking · retryable.

Repository checkout for the run workspace failed (auth, missing repo/branch, or
network). The recorded reason is **sanitized** — credential values never appear
in evidence. Fix the source checkout credentials (`SF_GIT_CHECKOUT_TOKEN`, a
surface separate from deploy and research credentials) or the repo/branch, then
retry materialization via `POST /api/runs/:id/workspace`. Retries increment the
recorded attempt; prior evidence is never duplicated.

### workspace.unavailable

**Workspace unavailable** · warn · blocking · not retryable.

The requested source cannot back a workspace on this runtime:

- **cloud runs never read laptop paths** (KTD5) — a local-only folder is
  recorded as unavailable, not silently "read",
- **local folders must resolve inside the approved working boundary** or an
  explicitly approved operator folder — traversal/outside-boundary paths are
  rejected with a paired `security.block` event, and
- a run with **no source input** has nothing to materialize (prompt/PRD-only
  runs get a fresh generated workspace when execution starts).

Follow the recorded `requiredAction` — provide a GitHub repository, upload PRD
content, or choose an approved folder — then retry materialization. A blind
retry without a setup change converges on the same recorded state.

## Execution + preflight failures

Execution is daemon-owned (E1): HTTP/CLI/MCP/Action commands enqueue or mutate
execution state on the ledger, and the execution daemon claims queue leases and
runs the work. A dry-run preflight rehearsal (X2) must pass before a start
enqueues worker execution.

### execution.blocked

**Execution blocked** · warn · blocking · not retryable.

Execution cannot proceed until an operator acts. Sources include a failed
preflight rehearsal, an abandoned queue lease after a crash/restart, or a
missing execution integration. The event's `reason`/`requiredAction` plus the
paired **operator intervention queue** entry (`intervention.raised`) say exactly
what to do; resolve the intervention, then retry (`POST /api/runs/:id/retry`)
or start the run again. A blind retry without the required action converges on
the same blocked state.

### execution.failed

**Execution failed** · error · blocking · retryable.

The execution attempt for this run failed (worker/executor error). Inspect the
recorded reason plus worker/adapter evidence, fix the cause, then retry
execution within the bounded retry budget — retries increment the queue job
attempt and the budget is enforced before enqueue.

### preflight.check_failed

**Preflight check failed** · warn · blocking · retryable.

One named dry-run rehearsal check failed before any worker mutated files: `dag`,
`workspace`, `write_scopes`, `credentials`, `adapters`, `gates`, `deploy`, or
`approvals`. Each failure records a `requiredAction` and raises an intervention
entry. Complete the action (materialize the workspace, add credentials, resolve
blocking research gaps…), then start the run again — preflight re-runs on the
next start attempt.

### preflight.failed

**Preflight failed** · error · blocking · retryable.

The dry-run execution rehearsal failed overall, so the start command did **not**
enqueue worker execution — no partial worker side effects exist. The event lists
the failed checks; resolve their interventions and start the run again.

## Adapter failures

See [adapter-troubleshooting.md](./adapter-troubleshooting.md) for setup, auth,
and capacity detail.

### adapter.setup_required

**Adapter setup required** · warn · blocking · not retryable.

No usable execution adapter is configured. Complete the setup action (install or
select a Codex / Claude Code CLI, or configure the API adapter), then start the
run.

### adapter.auth_failed

**Adapter authentication failed** · error · blocking · not retryable.

The selected adapter is not authenticated. Re-authenticate the local CLI (e.g.
`codex login`, or sign in to Claude Code) or fix the API key, then re-run. A
retry without re-auth fails identically.

### adapter.error

**Adapter error** · error · blocking · retryable.

A normalized adapter failure. `rate_limited` / `timeout` / `malformed_output`
are transient (a bounded retry may recover); `unavailable` / `tool_denied` /
`usage_limited` are terminal (address the cause first). Inspect the reason and
re-run.

## Sandbox failures

See [sandbox-troubleshooting.md](./sandbox-troubleshooting.md).

### sandbox.fallback

**Sandbox fallback (reduced trust)** · warn · non-blocking · not retryable.

Sandboxing was unavailable, so generated commands ran in the policy-gated
reduced-trust local fallback. Artifacts are marked **reduced trust** and
confidence is lowered. Install/start Docker or WSL2 for full-trust runs. This is
a degrade, not a hard failure — the run continues.

### sandbox.error

**Sandbox error** · error · blocking · retryable.

The sandbox failed to start or to run a command. Check Docker/WSL2 availability
and resources, then re-run — or allow the policy-gated local fallback.

## Quality gate + preview failures

### gate.failed

**Quality gate failed** · error · blocking · retryable.

A blocking gate failed (lint / typecheck / unit-test / secret-scan /
dependency-audit / preview-health). Read the gate output/evidence, fix the
generated code, and let the bounded gate retry re-run, or re-run the ticket.

### repair.failed

**Repair budget exhausted** · error · blocking · not retryable.

The bounded post-ticket gate-repair loop for a ticket exhausted its retry
budget. Repair attempts are ledger-derived (`repair.started` counts), so a
process restart never resets the budget. The run escalates instead of looping:
an operator intervention (`retry_choice`) and a stage review (`review.requested`
with `stage: execution`) are raised with the failing gate's evidence. Fix the
underlying cause, then approve the escalated review or retry execution — a
blind retry will exhaust again.

### preview.failed

**Local preview failed** · error · blocking · retryable.

Local preview health did not pass. Inspect the preview logs, fix app
start/health, then re-run the preview. No preview URL is shown until health
succeeds.

## Deploy failures

See [render-deployment.md](./render-deployment.md) for the full deploy order of
operations and the Render blueprint.

### deploy.setup_required

**Deploy setup required** · warn · blocking · not retryable.

Deploy is **paused, not failed**: connect a GitHub destination and configure
Render (`RENDER_API_KEY` + service id), then retry deploy. The local run,
package, and provenance remain complete.

### deploy.config_invalid

**Deploy config invalid** · error · blocking · retryable.

The generated `render.yaml` failed validation (build / start / migration / env /
health). Fix the blueprint and retry deploy.

### deploy.provider_failed

**Deploy provider failed** · error · blocking · retryable.

The Render build/deploy failed or timed out (a deploy **timeout** also surfaces
here). Inspect the attached deploy log evidence, address the cause, and retry.

### deploy.migration_failed

**Deploy migration failed** · error · blocking · retryable.

`prisma migrate deploy` failed during the Render build. Fix the migration history
or `DATABASE_URL`, then retry deploy.

### deploy.health_failed

**Hosted health failed** · error · blocking · retryable.

The hosted health check never passed within budget. Check the hosted service logs
and health endpoint, then retry. No hosted URL is shown until health passes.

## Security failures

These are fail-closed boundary events. See
[local-development.md](./local-development.md) for the operator token / command
guard model.

### security.block

**Security boundary block** · critical · blocking · not retryable.

A fail-closed boundary blocked an action (host-secret access, a disallowed path,
or a data-loss migration). Review the reason; **do not bypass** — adjust the
request or policy and re-run.

### security.command_rejected

**Command rejected** · critical · blocking · not retryable.

A mutating command was rejected (missing/expired operator token, bad
origin/CSRF, or a stale subject version). Reload the current projected state and
re-issue with a valid operator session.
