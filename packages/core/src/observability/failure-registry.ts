/**
 * Failure registry: the single, EXHAUSTIVE map from every failure-shaped core
 * event type to how an operator should treat it.
 *
 * "Failure-shaped" means every event family in the taxonomy that represents a
 * fault, a degraded state, a paused/blocked condition, a retry, or a rejected
 * action — i.e. every `*.failed`, `*.error`, `*.rejected`, `*.block`,
 * `*_invalid`, `*.cancelled`, `*.dead_lettered`, `*.retry`, `*.fallback`, and
 * `*.setup_required` event. The set is pinned in `FAILURE_EVENT_TYPES` (with a
 * compile-time `satisfies readonly FactoryEventType[]` guarantee) and the
 * registry is typed `Record<FailureEventType, ...>` so TypeScript refuses to
 * compile if any pinned class is left unmapped.
 *
 * Each entry answers four operator questions:
 *   - severity     — how loud is this on the ledger / operator dashboard,
 *   - blocking      — does it stop the run / pipeline / sub-flow from progressing,
 *   - retryable     — can a bounded retry or re-run plausibly recover once the
 *                     cause is addressed (vs. needing setup/policy/human action),
 *   - rescueAction  — the human-readable thing an operator does to recover.
 *
 * `runbook` points every entry at its section in
 * `docs/runbooks/failure-taxonomy.md`. The registry and that runbook are kept in
 * sync by a test (`failure-registry.test.ts`) that asserts the runbook has a
 * heading for every failure class and no headings for unknown ones.
 *
 * Pure data + pure lookups: no clocks, randomness, or I/O.
 */
import type { EventSeverity, FactoryEventType } from '../events/event-types';

/**
 * Every failure-shaped event type, in canonical taxonomy order. Pinned as a
 * tuple so `FailureEventType` is a precise union and the registry below is
 * exhaustively typed; `satisfies` proves each member is a real event type.
 */
export const FAILURE_EVENT_TYPES = [
  'run.failed',
  'run.cancelled',
  'ticket.dead_lettered',
  'worker.retry',
  'worker.failed',
  'worker.cancelled',
  'adapter.setup_required',
  'adapter.auth_failed',
  'adapter.error',
  'sandbox.fallback',
  'sandbox.error',
  'gate.failed',
  'preview.failed',
  'deploy.setup_required',
  'deploy.config_invalid',
  'deploy.provider_failed',
  'deploy.migration_failed',
  'deploy.health_failed',
  'security.block',
  'security.command_rejected',
] as const satisfies readonly FactoryEventType[];

/** The closed union of failure-shaped event types covered by the registry. */
export type FailureEventType = (typeof FAILURE_EVENT_TYPES)[number];

/** How an operator should treat one failure class. */
export interface FailureRegistryEntry {
  /** The failure-shaped event type this entry describes. */
  readonly type: FailureEventType;
  /** Short human label for dashboards/runbooks. */
  readonly title: string;
  /** Ledger/alert severity. */
  readonly severity: EventSeverity;
  /** Whether this stops the run / pipeline / affected sub-flow from progressing. */
  readonly blocking: boolean;
  /** Whether a bounded retry or re-run can recover once the cause is addressed. */
  readonly retryable: boolean;
  /** The human-readable recovery action. */
  readonly rescueAction: string;
  /** Reference into `docs/runbooks/failure-taxonomy.md`. */
  readonly runbook: string;
}

/** Spec used to build a registry entry; `runbook` is derived from `type`. */
type EntrySpec = Omit<FailureRegistryEntry, 'runbook'>;

/** GitHub-style anchor for a `### <type>` heading (drops dots, keeps underscores). */
function runbookRef(type: FailureEventType): string {
  return `docs/runbooks/failure-taxonomy.md#${type.replace(/\./g, '')}`;
}

const ENTRY_SPECS: readonly EntrySpec[] = [
  {
    type: 'run.failed',
    title: 'Run failed',
    severity: 'error',
    blocking: true,
    retryable: true,
    rescueAction:
      'Open the run, read run.failed reason and the last failing ticket/gate; fix the cause, then re-create the run. Replay the ledger to confirm the failure point.',
  },
  {
    type: 'run.cancelled',
    title: 'Run cancelled',
    severity: 'warn',
    blocking: true,
    retryable: true,
    rescueAction:
      'The run was cancelled by an operator or supervisor. If cancellation was unintended, re-create the run; in-flight workers/adapters were asked to stop.',
  },
  {
    type: 'ticket.dead_lettered',
    title: 'Ticket dead-lettered',
    severity: 'error',
    blocking: true,
    retryable: false,
    rescueAction:
      'Retry budget for this ticket is exhausted. Inspect the attached gate/worker evidence, fix the underlying cause, then re-plan or re-run the ticket — a blind retry will not help.',
  },
  {
    type: 'worker.retry',
    title: 'Worker retrying',
    severity: 'warn',
    blocking: false,
    retryable: true,
    rescueAction:
      'A transient worker/gate failure triggered a bounded retry; the attempt count is observable. No action unless retries exhaust and the ticket dead-letters.',
  },
  {
    type: 'worker.failed',
    title: 'Worker failed',
    severity: 'error',
    blocking: true,
    retryable: true,
    rescueAction:
      'A worker failed for a ticket. Review the worker reason plus adapter/gate evidence; the runner retries within budget, otherwise fix the cause and re-run the ticket.',
  },
  {
    type: 'worker.cancelled',
    title: 'Worker cancelled',
    severity: 'warn',
    blocking: false,
    retryable: true,
    rescueAction:
      'A worker was cancelled (run cancel or superseded attempt). Re-run the ticket if the cancellation was unintended; projections stay consistent.',
  },
  {
    type: 'adapter.setup_required',
    title: 'Adapter setup required',
    severity: 'warn',
    blocking: true,
    retryable: false,
    rescueAction:
      'Complete the adapter setup action (install/select a Codex or Claude Code CLI, or configure the API adapter), then start the run. See adapter-troubleshooting.md.',
  },
  {
    type: 'adapter.auth_failed',
    title: 'Adapter authentication failed',
    severity: 'error',
    blocking: true,
    retryable: false,
    rescueAction:
      'Re-authenticate the local CLI adapter (e.g. log in to Codex/Claude) or fix the API key, then re-run. A retry without re-auth will fail identically. See adapter-troubleshooting.md.',
  },
  {
    type: 'adapter.error',
    title: 'Adapter error',
    severity: 'error',
    blocking: true,
    retryable: true,
    rescueAction:
      'Inspect the normalized adapter error (rate-limit/timeout/malformed are transient; unavailable/tool-denied/usage-limited are terminal). Address the cause and re-run. See adapter-troubleshooting.md.',
  },
  {
    type: 'sandbox.fallback',
    title: 'Sandbox fallback (reduced trust)',
    severity: 'warn',
    blocking: false,
    retryable: false,
    rescueAction:
      'Sandboxing was unavailable so generated commands ran in the policy-gated reduced-trust local fallback; artifacts are marked reduced trust. Install/start Docker or WSL2 for full-trust runs. See sandbox-troubleshooting.md.',
  },
  {
    type: 'sandbox.error',
    title: 'Sandbox error',
    severity: 'error',
    blocking: true,
    retryable: true,
    rescueAction:
      'The sandbox failed to start or run a command. Check Docker/WSL2 availability and resources, then re-run — or allow the policy-gated local fallback. See sandbox-troubleshooting.md.',
  },
  {
    type: 'gate.failed',
    title: 'Quality gate failed',
    severity: 'error',
    blocking: true,
    retryable: true,
    rescueAction:
      'Read the failed gate output/evidence (lint/typecheck/test/secret-scan/dependency-audit/preview-health), fix the generated code, and let the bounded gate retry re-run, or re-run the ticket.',
  },
  {
    type: 'preview.failed',
    title: 'Local preview failed',
    severity: 'error',
    blocking: true,
    retryable: true,
    rescueAction:
      'Local preview health did not pass. Inspect the preview logs, fix app start/health, then re-run the preview. No preview URL is shown until health succeeds.',
  },
  {
    type: 'deploy.setup_required',
    title: 'Deploy setup required',
    severity: 'warn',
    blocking: true,
    retryable: false,
    rescueAction:
      'Deploy is paused (not failed): connect a GitHub destination and configure Render (RENDER_API_KEY + service id), then retry deploy. The local run, package, and provenance remain complete. See render-deployment.md.',
  },
  {
    type: 'deploy.config_invalid',
    title: 'Deploy config invalid',
    severity: 'error',
    blocking: true,
    retryable: true,
    rescueAction:
      'The generated render.yaml failed validation (build/start/migration/env/health). Fix the blueprint and retry deploy. See render-deployment.md.',
  },
  {
    type: 'deploy.provider_failed',
    title: 'Deploy provider failed',
    severity: 'error',
    blocking: true,
    retryable: true,
    rescueAction:
      'Render build/deploy failed or timed out. Inspect the attached deploy log evidence, address the cause, and retry deploy. See render-deployment.md.',
  },
  {
    type: 'deploy.migration_failed',
    title: 'Deploy migration failed',
    severity: 'error',
    blocking: true,
    retryable: true,
    rescueAction:
      'prisma migrate deploy failed during the Render build. Fix the migration history or DATABASE_URL, then retry deploy. See render-deployment.md.',
  },
  {
    type: 'deploy.health_failed',
    title: 'Hosted health failed',
    severity: 'error',
    blocking: true,
    retryable: true,
    rescueAction:
      'The hosted health check never passed within budget. Check the hosted service logs and health endpoint, then retry deploy. No hosted URL is shown until health passes. See render-deployment.md.',
  },
  {
    type: 'security.block',
    title: 'Security boundary block',
    severity: 'critical',
    blocking: true,
    retryable: false,
    rescueAction:
      'A fail-closed security boundary blocked an action (host-secret access, disallowed path, or data-loss migration). Review the reason; do NOT bypass — adjust the request or policy and re-run.',
  },
  {
    type: 'security.command_rejected',
    title: 'Command rejected',
    severity: 'critical',
    blocking: true,
    retryable: false,
    rescueAction:
      'A mutating command was rejected (missing/expired token, bad origin/CSRF, or stale subject version). Reload current projected state and re-issue with a valid operator session. See local-development.md.',
  },
];

/** The exhaustive registry, keyed by failure-shaped event type. */
export const FAILURE_REGISTRY: Readonly<Record<FailureEventType, FailureRegistryEntry>> =
  Object.freeze(
    Object.fromEntries(
      ENTRY_SPECS.map((spec) => [spec.type, { ...spec, runbook: runbookRef(spec.type) }]),
    ) as Record<FailureEventType, FailureRegistryEntry>,
  );

const FAILURE_TYPE_SET = new Set<string>(FAILURE_EVENT_TYPES);

/** Whether `type` is a failure-shaped event type covered by the registry. */
export function isFailureEventType(type: unknown): type is FailureEventType {
  return typeof type === 'string' && FAILURE_TYPE_SET.has(type);
}

/** Look up the registry entry for a failure type, or `undefined` if not a failure. */
export function lookupFailure(type: string): FailureRegistryEntry | undefined {
  return isFailureEventType(type) ? FAILURE_REGISTRY[type] : undefined;
}

/** Every registry entry, in canonical taxonomy order. */
export function listFailures(): readonly FailureRegistryEntry[] {
  return FAILURE_EVENT_TYPES.map((type) => FAILURE_REGISTRY[type]);
}
