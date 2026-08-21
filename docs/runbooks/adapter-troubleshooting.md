# Runbook: Adapter Troubleshooting

Diagnosing the execution adapters (local Codex CLI, local Claude Code CLI, and
the API adapter stub) when a run cannot start, stalls, or throttles. Adapter
failures are normalized in `packages/core/src/adapters/adapter-errors.ts` and
classed in [failure-taxonomy.md](./failure-taxonomy.md).

## Where adapter health shows up

- **Operator dashboard** (`/operator`) → **Adapters** panel: capacity, throttle,
  and setup/auth/error occurrence counts.
- **Setup checklist** (Factory Floor home) → **Execution adapter** item.
- **Ledger**: `adapter.selected`, `adapter.setup_required`, `adapter.auth_failed`,
  `adapter.error`, `adapter.capacity_changed`.

## Normalized adapter error kinds

Every raw spawn/exec/transport failure funnels through `normalizeAdapterError`
into one closed set. Retryable kinds may recover from a bounded retry; terminal
kinds need a fix first.

| Kind               | Retryable | Typical cause                                      | Rescue                                                          |
| ------------------ | --------- | -------------------------------------------------- | --------------------------------------------------------------- |
| `rate_limited`     | yes       | provider 429 / "too many requests"                 | Wait for the advertised backoff; reduce the worker cap; re-run. |
| `timeout`          | yes       | slow model / network deadline                      | Re-run; check connectivity; raise the timeout if configurable.  |
| `malformed_output` | yes       | unparseable adapter output                         | Re-run; if persistent, inspect the adapter version / prompt.    |
| `unavailable`      | no        | CLI not installed (`ENOENT`), unclassified failure | Install/select the CLI; confirm it is on `PATH`.                |
| `unauthenticated`  | no        | not logged in / bad API key (401/403)              | Re-authenticate (see below) then re-run.                        |
| `usage_limited`    | no        | quota / out of credits / billing                   | Resolve billing/quota with the provider; switch adapter.        |
| `tool_denied`      | no        | permission denied (`EACCES`/`EPERM`), tool blocked | Grant the permission or adjust policy; do not bypass security.  |
| `cancelled`        | n/a       | operator/run cancellation (`AbortError`)           | Not a fault; re-run if unintended.                              |

## Symptom → fix

### "Adapter setup required" (run will not start)

The ledger shows `adapter.setup_required` and the setup checklist flags the
execution adapter.

1. **Codex CLI:** install the Codex CLI and confirm `codex --version` works in the
   same shell the factory launched from.
2. **Claude Code CLI:** install Claude Code and confirm it runs locally.
3. **API adapter:** provide the API adapter configuration/key if you are not using
   a local CLI.
4. Select the adapter in the Factory Floor run control and start the run.

### "Adapter authentication failed"

The ledger shows `adapter.auth_failed`. A retry without re-auth fails identically.

1. **Codex:** `codex login` (or the documented auth command) and verify a session
   exists.
2. **Claude Code:** sign in locally.
3. **API:** fix the API key / credentials.
4. Re-run. The adapter should emit `adapter.selected` next.

### "Adapter error" mid-run

Read the normalized kind from the ledger reason:

- Transient (`rate_limited`/`timeout`/`malformed_output`): the worker runner
  retries within budget; if exhausted the ticket dead-letters — fix the cause and
  re-run the ticket.
- Terminal (`unavailable`/`tool_denied`/`usage_limited`): address the cause first
  (install/auth/billing/policy), then re-run.

### Capacity throttled below the requested cap

The Adapters panel shows **capacity throttled** and the ledger has
`adapter.capacity_changed` with a reason (e.g. CPU budget). This is expected
adaptive behavior — the worker cap is an **upper bound**, computed as
`min(ready tickets, requested cap, adapter capacity, sandbox capacity, CPU/memory
budget, write-scope availability, review policy)`. To raise effective capacity,
free system resources or lower contention; the cap itself stays operator-set
(1–20, default 10).

## Nested-agent note

When a Claude/Codex skill wrapper invokes the factory and the selected worker
adapter is the same agent family, nested-agent metadata is recorded
(`run.created.callerFamily`). This is informational, not a failure.

## Related

- [failure-taxonomy.md](./failure-taxonomy.md) — adapter failure classes + rescue.
- [sandbox-troubleshooting.md](./sandbox-troubleshooting.md) — sandbox capacity.
- [local-development.md](./local-development.md) — operator token / local startup.
