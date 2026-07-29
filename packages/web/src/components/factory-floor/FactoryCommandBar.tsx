'use client';

/**
 * FactoryCommandBar — factory-wide execution controls, rendered above the
 * intervention queue on the first screen:
 *
 *   - HELD banner + Resume: the daemon boots held, so opening the factory
 *     never runs queued work automatically. The banner says so honestly and
 *     the Resume button is the single explicit way to start draining.
 *   - Hold: re-engage the gate (stop starting NEW work) while active.
 *   - Cancel all tasks: one guarded command that cancels every cancellable
 *     run and propagates to queued/in-flight execution work. Destructive, so
 *     it takes an inline two-step confirm instead of firing on first click.
 *   - New session (U6/AE1): one guarded command that archives every visible
 *     run and opens a clean floor. Active runs trigger the server's ask-once
 *     409 — the confirm then NAMES the actives before cancel-and-archive.
 *   - Factory reset (U6/AE3, R9): destructive wipe, visually and semantically
 *     SEPARATED from New Session in its own danger section with a typed
 *     confirmation that renders the server's pre-flight enumeration.
 *
 * R15 stale-tab guard: a reset-generation change in the polled overview means
 * this tab's credentials were wiped — a forced-reload banner renders and every
 * mutation control here locks until reload.
 *
 * State is never optimistic: every render is derived from the polled floor
 * projection (owned by FactoryFloor's single floor-status loop and passed
 * down as props), and mutations go through the command guard (token + CSRF)
 * exactly like the per-run command bar.
 */
import { useEffect, useRef, useState } from 'react';
import { useSession } from '../session-context';
import {
  cancelAllRuns,
  factoryReset,
  holdFactoryExecution,
  resumeFactoryExecution,
  startNewSession,
} from '../../lib/api-client';
import type {
  CancelAllRunsResult,
  FactoryResetEnumeration,
  MutationResult,
  NewSessionActiveRun,
  NewSessionResult,
} from '../../lib/api-client';
import { useResetGenerationGuard } from '../../lib/use-execution-overview';
import type { ExecutionOverview } from '../../lib/types';
import { Mono } from './primitives';

type Phase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'busy'; readonly action: string }
  | { readonly kind: 'confirm-cancel-all' }
  | { readonly kind: 'confirm-new-session' }
  | {
      readonly kind: 'confirm-new-session-actives';
      readonly activeRuns: readonly NewSessionActiveRun[];
    }
  | { readonly kind: 'confirm-reset' }
  | { readonly kind: 'notice'; readonly message: string }
  | { readonly kind: 'error'; readonly message: string };

/**
 * Forced-reload banner (R15): rendered when this tab must reload — either the
 * reset happened HERE (generation from the reset response) or the polled
 * overview's reset generation changed under us (reset from another surface).
 * Shared with RunDetail so both surfaces explain the same discontinuity in
 * the same words.
 */
export function ResetReloadBanner({ ownGeneration }: { readonly ownGeneration?: number }) {
  return (
    <div className="banner banner--error" role="alert" data-testid="factory-reset-reload">
      <span className="banner__body">
        {ownGeneration !== undefined
          ? `Factory reset complete — generation ${ownGeneration}. Reload to open the fresh factory; this tab's credentials are gone.`
          : "This factory was reset from another surface. Reload to reconnect — this tab's credentials no longer work."}
      </span>
      <button
        type="button"
        className="btn btn--sm btn--primary"
        onClick={() => window.location.reload()}
      >
        Reload
      </button>
    </div>
  );
}

export function FactoryCommandBar({
  overview,
  reconnecting = false,
  onRefresh,
  onChanged,
}: {
  /** The polled overview, owned by the parent's floor-status loop. */
  readonly overview: ExecutionOverview;
  /** True while the owning poll loop is failing (honest reconnect badge). */
  readonly reconnecting?: boolean;
  /** Re-poll the floor status now — fired after ANY settled command (a
   *  rejected command also re-syncs, so a stale gate never lingers). */
  readonly onRefresh?: () => void;
  /** Called after a successful mutation so the parent reloads run state. */
  readonly onChanged?: () => void;
}) {
  const session = useSession();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  /** Set when THIS tab performed the reset (the response's new generation). */
  const [resetHere, setResetHere] = useState<number | null>(null);
  const busy = phase.kind === 'busy';
  const { execution, queue } = overview;
  const waiting = queue.queued + queue.leased;

  // R15: a generation change means the operator token and CSRF state were
  // wiped — every command would fail with unexplained guard errors. Lock all
  // mutations and demand a reload instead of failing silently.
  const resetElsewhere = useResetGenerationGuard(overview.resetGeneration);
  const reloadRequired = resetHere !== null || resetElsewhere;
  const locked = reloadRequired;

  // Unmount guard (same contract as RunCommandBar): an in-flight command that
  // settles after unmount must not set state or trigger the parent refresh.
  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  if (!execution.enabled) {
    // No execution daemon on this instance — there is nothing to control.
    return null;
  }

  async function perform<T>(
    action: string,
    request: () => Promise<MutationResult<T>>,
    /** Optional notice for a success; `undefined` returns quietly to idle. */
    describe?: (data: T) => string | undefined,
  ): Promise<void> {
    setPhase({ kind: 'busy', action });
    try {
      const result = await request();
      if (cancelledRef.current) {
        return;
      }
      if (result.ok) {
        const message = describe?.(result.data);
        setPhase(message === undefined ? { kind: 'idle' } : { kind: 'notice', message });
        onRefresh?.();
        onChanged?.();
        return;
      }
      onRefresh?.();
      setPhase({
        kind: 'error',
        message: result.message ?? `${action} was not accepted (${result.error}).`,
      });
    } catch (error) {
      if (cancelledRef.current) {
        return;
      }
      // A network error does NOT mean the command failed server-side — it may
      // have landed after processing. Re-sync immediately rather than showing
      // a stale gate until the next poll interval.
      onRefresh?.();
      const message = error instanceof Error ? error.message : `Network error during ${action}.`;
      setPhase({ kind: 'error', message });
    }
  }

  /**
   * New Session (AE1): the first confirm sends WITHOUT `confirmActive`; the
   * server's ask-once 409 (`active_runs_present`) turns into the second
   * confirm naming the actives, and only an explicit user confirmation
   * re-sends with `confirmActive: true`. The 409 changes nothing server-side,
   * so aborting there leaves everything untouched.
   */
  async function performNewSession(confirmActive: boolean): Promise<void> {
    setPhase({ kind: 'busy', action: 'new session' });
    try {
      const result = await startNewSession(session, confirmActive ? { confirmActive: true } : {});
      if (cancelledRef.current) {
        return;
      }
      if (result.ok) {
        setPhase({ kind: 'notice', message: describeNewSession(result.data) });
        onRefresh?.();
        onChanged?.();
        return;
      }
      if (result.error === 'active_runs_present') {
        setPhase({
          kind: 'confirm-new-session-actives',
          activeRuns: parseActiveRuns(result.details),
        });
        return;
      }
      onRefresh?.();
      setPhase({
        kind: 'error',
        message: result.message ?? `New session was not accepted (${result.error}).`,
      });
    } catch (error) {
      if (cancelledRef.current) {
        return;
      }
      onRefresh?.();
      const message = error instanceof Error ? error.message : 'Network error during new session.';
      setPhase({ kind: 'error', message });
    }
  }

  function describeCancelAll(data: CancelAllRunsResult): string {
    const count = data.cancelledCount;
    return count === 0
      ? 'No active tasks to cancel — every run was already finished or cancelled.'
      : `Cancelled ${count} run${count === 1 ? '' : 's'}; queued and in-flight work stops.`;
  }

  // A resume that leaves the daemon loop stopped is a trap: the gate is open
  // but nothing drains. Surface it as a notice instead of returning to idle.
  function describeResume(data: { running?: boolean }): string | undefined {
    return data.running === false
      ? 'Resumed, but the execution daemon is not running — queued work will not drain. Check server logs.'
      : undefined;
  }

  // One shared element so the held banner and the active row cannot drift
  // (the server defaults the cancel reason to "operator cancel-all").
  const cancelAll = (
    <CancelAllControl
      busy={busy}
      locked={locked}
      phase={phase}
      waiting={waiting}
      onArm={() => setPhase({ kind: 'confirm-cancel-all' })}
      onDisarm={() => setPhase({ kind: 'idle' })}
      onConfirm={() => void perform('cancel all', () => cancelAllRuns(session), describeCancelAll)}
    />
  );

  // Shared for the same reason: New Session applies in both gate states.
  const newSession = (
    <NewSessionControl
      busy={busy}
      locked={locked}
      phase={phase}
      onArm={() => setPhase({ kind: 'confirm-new-session' })}
      onDisarm={() => setPhase({ kind: 'idle' })}
      onConfirm={() => void performNewSession(false)}
      onConfirmActives={() => void performNewSession(true)}
    />
  );

  return (
    <section
      className="stack"
      aria-label="Factory execution controls"
      style={{ gap: 'var(--space-4)' }}
    >
      {reloadRequired ? <ResetReloadBanner ownGeneration={resetHere ?? undefined} /> : null}

      {execution.held ? (
        <div className="banner banner--warn" role="status" data-testid="factory-held-banner">
          <span className="banner__body">
            Execution is held — nothing runs automatically.
            {waiting > 0
              ? ` ${waiting} task${waiting === 1 ? ' is' : 's are'} waiting for your resume.`
              : ' Queued work will wait for your resume.'}
          </span>
          <button
            type="button"
            className="btn btn--sm btn--primary"
            disabled={busy || locked}
            data-testid="factory-resume"
            onClick={() =>
              void perform('resume', () => resumeFactoryExecution(session), describeResume)
            }
          >
            {phase.kind === 'busy' && phase.action === 'resume' ? 'Resuming…' : 'Resume execution'}
          </button>
          {newSession}
          {cancelAll}
          {reconnecting ? <span className="badge sev-warn">reconnecting</span> : null}
        </div>
      ) : (
        <div className="row" role="group" aria-label="Factory-wide execution commands">
          <span className="badge" data-testid="factory-active-badge">
            execution active
          </span>
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            disabled={busy || locked}
            data-testid="factory-hold"
            onClick={() => void perform('hold', () => holdFactoryExecution(session))}
          >
            {phase.kind === 'busy' && phase.action === 'hold' ? 'Holding…' : 'Hold new work'}
          </button>
          {newSession}
          {cancelAll}
          {reconnecting ? <span className="badge sev-warn">reconnecting</span> : null}
        </div>
      )}

      {phase.kind === 'notice' ? (
        <div className="banner banner--info" role="status" data-testid="factory-command-notice">
          <span className="banner__body">{phase.message}</span>
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={() => setPhase({ kind: 'idle' })}
          >
            Dismiss
          </button>
        </div>
      ) : null}
      {phase.kind === 'error' ? (
        <div className="banner banner--error" role="alert" data-testid="factory-command-error">
          <span className="banner__body">{phase.message}</span>
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={() => setPhase({ kind: 'idle' })}
          >
            Dismiss
          </button>
        </div>
      ) : null}

      {/* R9: Factory Reset lives in its OWN section, never beside New
          Session — same screen, different blast radius, different framing. */}
      <FactoryResetControl
        locked={locked}
        open={phase.kind === 'confirm-reset'}
        onArm={() => setPhase({ kind: 'confirm-reset' })}
        onDisarm={() => setPhase({ kind: 'idle' })}
        onComplete={(generation) => {
          setResetHere(generation);
          setPhase({ kind: 'idle' });
          onRefresh?.();
        }}
      />
    </section>
  );
}

/** Structural parse of the 409 ask-once body's `activeRuns` list. */
function parseActiveRuns(details: Record<string, unknown> | undefined): NewSessionActiveRun[] {
  const list = details?.activeRuns;
  if (!Array.isArray(list)) {
    return [];
  }
  const parsed: NewSessionActiveRun[] = [];
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const row = entry as Record<string, unknown>;
    if (typeof row.runId !== 'string') {
      continue;
    }
    parsed.push({
      runId: row.runId,
      title: typeof row.title === 'string' ? row.title : undefined,
      status: typeof row.status === 'string' ? row.status : 'unknown',
      executionState: typeof row.executionState === 'string' ? row.executionState : 'unknown',
    });
  }
  return parsed;
}

function describeNewSession(data: NewSessionResult): string {
  const archived = data.archived.length;
  const cancelled = data.cancelled.length;
  const failed = data.errors?.length ?? 0;
  const opening =
    archived === 0
      ? 'New session opened — nothing to archive.'
      : `New session opened — archived ${archived} run${archived === 1 ? '' : 's'}${
          cancelled > 0 ? ` (${cancelled} active cancelled first)` : ''
        }.`;
  const failures =
    failed > 0
      ? ` ${failed} run${failed === 1 ? '' : 's'} could not be archived and stay${failed === 1 ? 's' : ''} visible.`
      : '';
  return `${opening} Execution stays held.${failures}`;
}

/**
 * The destructive cancel-all control with its inline two-step confirm. Kept
 * as one component so the held banner and the active row render the exact
 * same behavior. Keyboard contract: arming moves focus to the SAFE "Keep
 * running" option, Escape disarms, and closing the confirm (either way)
 * returns focus to the arm button so keyboard users never lose their place.
 */
function CancelAllControl({
  busy,
  locked,
  phase,
  waiting,
  onArm,
  onDisarm,
  onConfirm,
}: {
  readonly busy: boolean;
  readonly locked: boolean;
  readonly phase: Phase;
  readonly waiting: number;
  readonly onArm: () => void;
  readonly onDisarm: () => void;
  readonly onConfirm: () => void;
}) {
  const confirming = phase.kind === 'confirm-cancel-all';
  const armRef = useRef<HTMLButtonElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  // Track the PREVIOUS confirm state so focus returns to the arm button
  // exactly when the confirm closes (disarm or confirm) — never on ordinary
  // re-renders that happen to leave the control in its resting state.
  const wasConfirmingRef = useRef(false);
  useEffect(() => {
    if (confirming) {
      keepRef.current?.focus();
    } else if (wasConfirmingRef.current) {
      armRef.current?.focus();
    }
    wasConfirmingRef.current = confirming;
  }, [confirming]);

  if (confirming) {
    return (
      <span
        className="row"
        role="group"
        aria-label="Confirm cancel all tasks"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            onDisarm();
          }
        }}
      >
        <span className="sev-warn" style={{ fontSize: 'var(--fs-2xs)' }}>
          Cancel every active run
          {waiting > 0 ? ` (${waiting} task${waiting === 1 ? '' : 's'} in the queue)` : ''}? Queued
          and in-flight work stops.
        </span>
        <button
          type="button"
          className="btn btn--sm btn--danger"
          disabled={locked}
          data-testid="cancel-all-confirm"
          onClick={onConfirm}
        >
          Confirm cancel all
        </button>
        <button
          ref={keepRef}
          type="button"
          className="btn btn--sm btn--ghost"
          data-testid="cancel-all-keep"
          onClick={onDisarm}
        >
          Keep running
        </button>
      </span>
    );
  }
  return (
    <button
      ref={armRef}
      type="button"
      className="btn btn--sm btn--danger"
      disabled={busy || locked}
      data-testid="cancel-all-tasks"
      onClick={onArm}
    >
      {phase.kind === 'busy' && phase.action === 'cancel all' ? 'Cancelling…' : 'Cancel all tasks'}
    </button>
  );
}

/**
 * New Session control (U6/AE1) with the SAME arm/confirm keyboard contract as
 * cancel-all: arming (either confirm stage) moves focus to the SAFE "Keep
 * this session" option, Escape disarms, and closing returns focus to the arm
 * button. Two confirm stages: the plain confirm (sends without
 * `confirmActive`) and the actives confirm, entered only via the server's
 * ask-once 409, which NAMES the active runs it would cancel first.
 */
function NewSessionControl({
  busy,
  locked,
  phase,
  onArm,
  onDisarm,
  onConfirm,
  onConfirmActives,
}: {
  readonly busy: boolean;
  readonly locked: boolean;
  readonly phase: Phase;
  readonly onArm: () => void;
  readonly onDisarm: () => void;
  readonly onConfirm: () => void;
  readonly onConfirmActives: () => void;
}) {
  const stage =
    phase.kind === 'confirm-new-session'
      ? ('ask' as const)
      : phase.kind === 'confirm-new-session-actives'
        ? ('actives' as const)
        : null;
  const armRef = useRef<HTMLButtonElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const wasConfirmingRef = useRef(false);
  useEffect(() => {
    if (stage !== null) {
      keepRef.current?.focus();
    } else if (wasConfirmingRef.current) {
      armRef.current?.focus();
    }
    wasConfirmingRef.current = stage !== null;
  }, [stage]);

  if (stage !== null) {
    const actives = phase.kind === 'confirm-new-session-actives' ? phase.activeRuns : [];
    return (
      <span
        className="row"
        role="group"
        aria-label={
          stage === 'ask' ? 'Confirm new session' : 'Confirm new session with active runs'
        }
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            onDisarm();
          }
        }}
      >
        {stage === 'ask' ? (
          <span className="sev-warn" style={{ fontSize: 'var(--fs-2xs)' }}>
            Archive every visible run and open a clean floor? Archived runs stay in run history;
            execution stays held.
          </span>
        ) : (
          <span className="stack" style={{ gap: 'var(--space-2)' }}>
            <span className="sev-warn" style={{ fontSize: 'var(--fs-2xs)' }}>
              {actives.length === 1 ? '1 run is' : `${actives.length} runs are`} still active — a
              new session cancels {actives.length === 1 ? 'it' : 'them'} first:
            </span>
            <ul className="stack" style={{ listStyle: 'none', margin: 0, padding: 0, gap: 2 }}>
              {actives.map((run) => (
                <li
                  key={run.runId}
                  className="row"
                  data-testid="new-session-active-run"
                  style={{ fontSize: 'var(--fs-2xs)' }}
                >
                  <Mono value={run.runId} max={20} copyable={false} />
                  <span className="muted">
                    {run.status} / {run.executionState.replace(/_/g, ' ')}
                  </span>
                </li>
              ))}
            </ul>
            {/* The 409 body carries no deploy state and the floor only knows
                the FOCUSED run's deploy aggregate, so this is one global
                warning line instead of a per-run flag (documented
                simplification): archive never touches external resources. */}
            <span className="muted" style={{ fontSize: 'var(--fs-2xs)' }}>
              Anything already deployed stays live — archiving never touches external services.
            </span>
          </span>
        )}
        <button
          type="button"
          className="btn btn--sm btn--danger"
          disabled={locked}
          data-testid={stage === 'ask' ? 'new-session-confirm' : 'new-session-confirm-actives'}
          onClick={stage === 'ask' ? onConfirm : onConfirmActives}
        >
          {stage === 'ask' ? 'Confirm new session' : 'Cancel actives and open new session'}
        </button>
        <button
          ref={keepRef}
          type="button"
          className="btn btn--sm btn--ghost"
          data-testid="new-session-keep"
          onClick={onDisarm}
        >
          Keep this session
        </button>
      </span>
    );
  }
  return (
    <button
      ref={armRef}
      type="button"
      className="btn btn--sm"
      disabled={busy || locked}
      data-testid="new-session"
      onClick={onArm}
    >
      {phase.kind === 'busy' && phase.action === 'new session'
        ? 'Opening new session…'
        : 'New session'}
    </button>
  );
}

/** Pre-flight state for the reset panel (from the intentionally-empty confirm). */
type ResetPreflight =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | {
      readonly kind: 'leased';
      readonly count: number;
      readonly enumeration: FactoryResetEnumeration | null;
    }
  | {
      readonly kind: 'ready';
      readonly requiredPhrase: string;
      readonly enumeration: FactoryResetEnumeration | null;
    };

/** Structural parse of the server's `wouldDestroy`/`destroyed` enumeration. */
function parseEnumeration(value: unknown): FactoryResetEnumeration | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const body = value as Record<string, unknown>;
  if (
    typeof body.runCount !== 'number' ||
    typeof body.archivedRunCount !== 'number' ||
    typeof body.eventCount !== 'number' ||
    !Array.isArray(body.paths) ||
    !Array.isArray(body.workspacePaths)
  ) {
    return null;
  }
  return {
    runCount: body.runCount,
    archivedRunCount: body.archivedRunCount,
    eventCount: body.eventCount,
    paths: body.paths.filter((p): p is string => typeof p === 'string'),
    workspacePaths: body.workspacePaths.filter((p): p is string => typeof p === 'string'),
    resetGeneration: typeof body.resetGeneration === 'number' ? body.resetGeneration : 0,
  };
}

/**
 * Factory Reset (U6/AE3, R9): its own danger section, never a sibling button
 * of New Session. Opening the panel fires a PRE-FLIGHT request with an
 * intentionally-empty `confirm` — the server's non-destructive 400
 * (`confirmation_mismatch`) returns `requiredPhrase` plus the `wouldDestroy`
 * enumeration, which the panel renders with literal counts and paths. The
 * confirm button stays disabled until the typed phrase matches EXACTLY, so a
 * wrong phrase never sends the destructive call (client belt) — and the
 * server rejects a mismatch anyway (AE3 braces). Keyboard contract mirrors
 * the other destructive controls: opening focuses the SAFE "Keep everything"
 * option, Escape closes, focus returns to the arm button.
 */
function FactoryResetControl({
  locked,
  open,
  onArm,
  onDisarm,
  onComplete,
}: {
  readonly locked: boolean;
  readonly open: boolean;
  readonly onArm: () => void;
  readonly onDisarm: () => void;
  /** The reset succeeded HERE — the parent renders the forced-reload banner. */
  readonly onComplete: (generation: number) => void;
}) {
  const session = useSession();
  const [preflight, setPreflight] = useState<ResetPreflight>({ kind: 'loading' });
  const [typed, setTyped] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const armRef = useRef<HTMLButtonElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const wasOpenRef = useRef(false);
  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  useEffect(() => {
    if (open) {
      keepRef.current?.focus();
    } else if (wasOpenRef.current) {
      armRef.current?.focus();
    }
    wasOpenRef.current = open;
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    setPreflight({ kind: 'loading' });
    setTyped('');
    setSubmitError(null);
    // Pre-flight: an INTENTIONALLY-EMPTY confirm. The server's 400 is
    // contractually non-destructive and carries `requiredPhrase` +
    // `wouldDestroy` — the enumeration this panel renders BEFORE any
    // destructive call. No server changes; documented in api-client.
    factoryReset(session, '').then(
      (result) => {
        if (cancelledRef.current) {
          return;
        }
        if (!result.ok && result.error === 'confirmation_mismatch') {
          const requiredPhrase = result.details?.requiredPhrase;
          if (typeof requiredPhrase === 'string' && requiredPhrase.length > 0) {
            setPreflight({
              kind: 'ready',
              requiredPhrase,
              enumeration: parseEnumeration(result.details?.wouldDestroy),
            });
            return;
          }
          setPreflight({ kind: 'error', message: 'The server did not name a required phrase.' });
          return;
        }
        if (!result.ok && result.error === 'jobs_leased') {
          const leased = result.details?.leasedJobs;
          setPreflight({
            kind: 'leased',
            count: Array.isArray(leased) ? leased.length : 0,
            enumeration: parseEnumeration(result.details?.wouldDestroy),
          });
          return;
        }
        setPreflight({
          kind: 'error',
          message: result.ok
            ? // An empty confirm must never reset; treat an OK as server drift.
              'The server accepted an empty confirmation — refusing to continue.'
            : (result.message ?? `Pre-flight was not accepted (${result.error}).`),
        });
      },
      (error: unknown) => {
        if (cancelledRef.current) {
          return;
        }
        setPreflight({
          kind: 'error',
          message: error instanceof Error ? error.message : 'Network error during pre-flight.',
        });
      },
    );
  }, [open, attempt, session]);

  async function submit(requiredPhrase: string): Promise<void> {
    if (typed !== requiredPhrase || submitting) {
      // Client belt (AE3): a mismatched phrase never sends the destructive
      // request — and the confirm button is disabled anyway.
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await factoryReset(session, typed);
      if (cancelledRef.current) {
        return;
      }
      setSubmitting(false);
      if (result.ok) {
        onComplete(result.data.resetGeneration);
        return;
      }
      setSubmitError(result.message ?? `Factory reset was not accepted (${result.error}).`);
    } catch (error) {
      if (cancelledRef.current) {
        return;
      }
      setSubmitting(false);
      setSubmitError(
        error instanceof Error ? error.message : 'Network error during factory reset.',
      );
    }
  }

  return (
    <section
      className="stack"
      aria-label="Factory reset"
      data-testid="factory-reset-zone"
      style={{
        gap: 'var(--space-4)',
        borderTop: '1px solid var(--border-subtle)',
        paddingTop: 'var(--space-8)',
      }}
    >
      {!open ? (
        // Resting state stays ONE compact row (KTD7 fold budget): the full
        // blast-radius explainer renders inside the armed panel instead.
        <div className="row">
          <button
            ref={armRef}
            type="button"
            className="btn btn--sm btn--danger"
            disabled={locked}
            data-testid="factory-reset-arm"
            onClick={onArm}
          >
            Factory reset…
          </button>
        </div>
      ) : (
        <div
          className="stack state-block state-block--error"
          role="group"
          aria-label="Confirm factory reset"
          data-testid="factory-reset-panel"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              onDisarm();
            }
          }}
        >
          <span className="muted" style={{ fontSize: 'var(--fs-2xs)' }}>
            Destroys every run, the whole ledger, and generated workspaces on this machine. Archived
            runs do not survive — this is not New Session.
          </span>
          {preflight.kind === 'loading' ? (
            <span className="muted">Checking what a reset would destroy…</span>
          ) : null}

          {preflight.kind === 'error' ? (
            <span className="row">
              <span className="sev-error">{preflight.message}</span>
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => setAttempt((n) => n + 1)}
              >
                Retry pre-flight
              </button>
            </span>
          ) : null}

          {preflight.kind === 'leased' ? (
            <span className="sev-warn">
              {preflight.count === 1 ? '1 job holds' : `${preflight.count} jobs hold`} an active
              lease — the server refuses to reset while work is leased. Cancel all tasks first, then
              re-check.
            </span>
          ) : null}

          {preflight.kind === 'leased' || preflight.kind === 'ready' ? (
            <EnumerationBlock enumeration={preflight.enumeration} />
          ) : null}

          {preflight.kind === 'leased' ? (
            <button type="button" className="btn btn--sm" onClick={() => setAttempt((n) => n + 1)}>
              Re-check leases
            </button>
          ) : null}

          {preflight.kind === 'ready' ? (
            <label className="stack" style={{ gap: 'var(--space-2)' }}>
              <span>
                Type <span className="mono">{preflight.requiredPhrase}</span> to confirm — nothing
                is sent until it matches exactly.
              </span>
              <input
                className="mono"
                data-testid="factory-reset-phrase"
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                disabled={submitting || locked}
              />
            </label>
          ) : null}

          {submitError !== null ? (
            <span className="sev-error" role="alert" data-testid="factory-reset-error">
              {submitError}
            </span>
          ) : null}

          <span className="row">
            {preflight.kind === 'ready' ? (
              <button
                type="button"
                className="btn btn--sm btn--danger"
                data-testid="factory-reset-confirm"
                disabled={typed !== preflight.requiredPhrase || submitting || locked}
                onClick={() => void submit(preflight.requiredPhrase)}
              >
                {submitting ? 'Resetting…' : 'Destroy and reset the factory'}
              </button>
            ) : null}
            <button
              ref={keepRef}
              type="button"
              className="btn btn--sm btn--ghost"
              data-testid="factory-reset-keep"
              onClick={onDisarm}
            >
              Keep everything
            </button>
          </span>
        </div>
      )}
    </section>
  );
}

/** The literal counts and paths a reset would destroy (AE3 — no summaries). */
function EnumerationBlock({
  enumeration,
}: {
  readonly enumeration: FactoryResetEnumeration | null;
}) {
  if (enumeration === null) {
    return (
      <span className="muted" data-testid="factory-reset-enumeration">
        The server did not enumerate what would be destroyed — proceed only if you know exactly what
        this factory holds.
      </span>
    );
  }
  const { runCount, archivedRunCount, eventCount, paths, workspacePaths } = enumeration;
  return (
    <div
      className="stack"
      data-testid="factory-reset-enumeration"
      style={{ gap: 'var(--space-2)' }}
    >
      <span>
        This destroys {runCount} run{runCount === 1 ? '' : 's'} ({archivedRunCount} archived) and{' '}
        {eventCount} ledger event{eventCount === 1 ? '' : 's'}:
      </span>
      <ul className="stack" style={{ listStyle: 'none', margin: 0, padding: 0, gap: 2 }}>
        {paths.map((path) => (
          <li key={path}>
            <Mono value={path} max={60} copyable={false} />
          </li>
        ))}
        {workspacePaths.map((path) => (
          <li key={path}>
            <Mono value={path} max={60} copyable={false} />{' '}
            <span className="muted">(generated workspace)</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
