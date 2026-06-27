# Runbook: Failure Taxonomy

Every failure-shaped event the Software Factory core can emit, and the operator
rescue action for each. This runbook is the human companion to the machine
source of truth, `packages/core/src/observability/failure-registry.ts`.

**Kept in sync by a test.** `packages/core/test/observability/failure-registry.test.ts`
asserts that this file has a `### <event.type>` heading for **every** registry
entry and **no** failure headings that are not in the registry — so the registry
and this taxonomy cannot drift. The registry is also proven exhaustive over the
event taxonomy: every event type whose name contains `fail`, `error`, `reject`,
`block`, `invalid`, `cancel`, `dead_letter`, `retry`, `fallback`, or
`setup_required` must have an entry.

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

| Event | Severity | Blocking | Retryable |
| --- | --- | --- | --- |
| `run.failed` | error | yes | yes |
| `run.cancelled` | warn | yes | yes |
| `ticket.dead_lettered` | error | yes | no |
| `worker.retry` | warn | no | yes |
| `worker.failed` | error | yes | yes |
| `worker.cancelled` | warn | no | yes |
| `adapter.setup_required` | warn | yes | no |
| `adapter.auth_failed` | error | yes | no |
| `adapter.error` | error | yes | yes |
| `sandbox.fallback` | warn | no | no |
| `sandbox.error` | error | yes | yes |
| `gate.failed` | error | yes | yes |
| `preview.failed` | error | yes | yes |
| `deploy.setup_required` | warn | yes | no |
| `deploy.config_invalid` | error | yes | yes |
| `deploy.provider_failed` | error | yes | yes |
| `deploy.migration_failed` | error | yes | yes |
| `deploy.health_failed` | error | yes | yes |
| `security.block` | critical | yes | no |
| `security.command_rejected` | critical | yes | no |

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
