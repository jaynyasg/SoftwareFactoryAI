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
 *
 * State is never optimistic: every render is derived from the polled floor
 * projection (owned by FactoryFloor's single floor-status loop and passed
 * down as props), and mutations go through the command guard (token + CSRF)
 * exactly like the per-run command bar.
 */
import { useEffect, useRef, useState } from 'react';
import { useSession } from '../session-context';
import { cancelAllRuns, holdFactoryExecution, resumeFactoryExecution } from '../../lib/api-client';
import type { CancelAllRunsResult, MutationResult } from '../../lib/api-client';
import type { ExecutionOverview } from '../../lib/types';

type Phase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'busy'; readonly action: string }
  | { readonly kind: 'confirm-cancel-all' }
  | { readonly kind: 'notice'; readonly message: string }
  | { readonly kind: 'error'; readonly message: string };

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
  const busy = phase.kind === 'busy';
  const { execution, queue } = overview;
  const waiting = queue.queued + queue.leased;

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
      phase={phase}
      waiting={waiting}
      onArm={() => setPhase({ kind: 'confirm-cancel-all' })}
      onDisarm={() => setPhase({ kind: 'idle' })}
      onConfirm={() => void perform('cancel all', () => cancelAllRuns(session), describeCancelAll)}
    />
  );

  return (
    <section
      className="stack"
      aria-label="Factory execution controls"
      style={{ gap: 'var(--space-4)' }}
    >
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
            disabled={busy}
            data-testid="factory-resume"
            onClick={() =>
              void perform('resume', () => resumeFactoryExecution(session), describeResume)
            }
          >
            {phase.kind === 'busy' && phase.action === 'resume' ? 'Resuming…' : 'Resume execution'}
          </button>
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
            disabled={busy}
            data-testid="factory-hold"
            onClick={() => void perform('hold', () => holdFactoryExecution(session))}
          >
            {phase.kind === 'busy' && phase.action === 'hold' ? 'Holding…' : 'Hold new work'}
          </button>
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
    </section>
  );
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
  phase,
  waiting,
  onArm,
  onDisarm,
  onConfirm,
}: {
  readonly busy: boolean;
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
      disabled={busy}
      data-testid="cancel-all-tasks"
      onClick={onArm}
    >
      {phase.kind === 'busy' && phase.action === 'cancel all' ? 'Cancelling…' : 'Cancel all tasks'}
    </button>
  );
}
