# Runbook: Golden-Run Replay

A **golden run** is a recorded JSONL event log of a complete factory run, pinned
as a fixture so future work can validate the full event → projection → UI
contract **without live adapters, sandboxes, or deploys**. Because the ledger is
the source of truth and every view is a pure replay projection, replaying a
recorded log reconstructs identical run, ticket, artifact, operator, and deploy
state — and the same UI.

The committed golden run:

- **File:** `tests/fixtures/golden-runs/ai-services-marketplace.jsonl`
  (one JSON event envelope per line, contiguous per-run sequence from 1).
- **Run id:** `golden-ai-services-marketplace`.
- **Arc:** `run.created` → `supervisor.decision` → adapter setup/auth failure →
  `adapter.selected` → `ticket.created` ×12 (the marketplace DAG) →
  `run.planned`/`run.started` → worker execution with a `sandbox.fallback`
  (reduced trust), a `gate.failed` + `worker.retry` → `gate.passed`, an
  `adapter.capacity_changed` throttle (5 → 3), `preview.ready`,
  `review.requested`/`review.decided`, `artifact.created`/`confidence_computed`,
  `package.created`, a string of deploy failures
  (`setup_required`/`config_invalid`/`provider_failed`/`migration_failed`/
  `health_failed`) that recover to `deploy.hosted_ready`, and `run.completed`.
- It exercises the full failure taxonomy yet ends healthy, so the operator panels
  have every state to render and the hosted URL appears only after health passes.

## Replaying for debugging

### 1. Replay into projections (no browser)

Load the JSONL and fold it with the core projections / observability:

```ts
import { readFileSync } from 'node:fs';
import {
  projectRun,
  projectTickets,
  projectArtifacts,
  projectOperator,
  computeOperatorMetrics,
  computeRunDiagnostics,
} from '@software-factory/core';

const raw = readFileSync('tests/fixtures/golden-runs/ai-services-marketplace.jsonl', 'utf8')
  .split('\n')
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line));

const run = projectRun(raw);
const operator = projectOperator(raw);
const metrics = computeOperatorMetrics(raw, { now: Date.now() });
const diagnostics = computeRunDiagnostics(raw);
```

Projections are pure: replaying the same log twice yields deep-equal output and
no diagnostics (see the determinism test below).

### 2. Replay into the UI (browser)

The U4–U7 runtime is not wired into the web dev server, so seed the recorded log
through the dev-only `/data/seed` route (it appends through the singleton store
in-process). Use a **fresh run id** so parallel tests / repeated seeds do not
collide:

```ts
import { seedRun } from './seed-run'; // tests/e2e/seed-run.ts
// reidentify(events, freshRunId) rebinds runId + run-subject ids, keeps ticket ids
await seedRun(page.request, reidentify(loadGolden(), runId));
await page.goto(`/runs/${runId}`);          // user run surface
await page.goto(`/operator?runId=${runId}`); // operator dashboard (scope by run id)
```

The operator dashboard is **scoped by `?runId=`** on purpose: it never silently
follows a newer run, so replays stay deterministic and parallel-safe.

## The replay tests

- `tests/e2e/golden-run-replay.spec.ts`
  - **replay determinism** (no browser): projects the log twice and asserts the
    run/ticket/artifact/operator/metrics/diagnostics outputs are deep-equal with
    no unexpected diagnostics, and reconstructs the expected end state.
  - **UI**: seeds the golden run and asserts the run page + `/operator` render the
    throttle, reduced-trust fallback, gate-failed, deploy states, and the hosted
    URL (shown only after hosted health passes).

Run it:

```bash
pnpm exec playwright test tests/e2e/golden-run-replay.spec.ts
```

## Recording a new golden run

A golden run is just a recording. Two ways to produce one:

1. **From a real run (preferred when the runtime is wired in):** run the factory,
   then export the run's ledger to JSONL (the `/api/runs/:id/events` projection /
   the filesystem store under `.factory/events`). One envelope per line, ordered
   by sequence.
2. **Deterministic recorder (used for this fixture):**
   `tests/fixtures/golden-runs/_generate.mjs` builds the envelope log with fixed
   ids/timestamps and contiguous sequences:

   ```bash
   node tests/fixtures/golden-runs/_generate.mjs
   ```

### Rules for a valid golden run

- Every line is a fully-formed envelope satisfying core's `isFactoryEvent`
  (version, eventId, runId, known `type`, integer `sequence` ≥ 1, finite
  `timestamp`, valid `severity`, `actor`, `subject`, `payload`).
- One run id; per-run `sequence` is **contiguous from 1** (no gaps/dupes) so
  replay shows no `sequence_gap`/`duplicate_sequence` diagnostics.
- **Internally consistent**: failures are followed by their recovery
  (`gate.failed` → `gate.passed`, deploy failures → `deploy.hosted_ready`) if the
  run is meant to end healthy; the hosted URL only appears in `deploy.hosted_ready`.
- Keep it deterministic (fixed ids/clock) so the committed file is stable and the
  determinism test holds.

## Related

- [failure-taxonomy.md](./failure-taxonomy.md) — the failure classes the golden run exercises.
- [local-development.md](./local-development.md) — local startup + the `.factory/` store.
