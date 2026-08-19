'use client';

/**
 * FactoryCommandBar — factory-wide execution controls, rendered above the
 * intervention queue on the first screen. CONTEXTUAL by design (calm by
 * default, loud on risk — DESIGN.md §1): every control renders only while it
 * can actually do something, so an empty factory shows a single quiet gate
 * badge instead of a permanent banner with dead buttons.
 *
 *   - HELD banner + Resume: shown only while held work exists on the queue.
 *     The daemon boots held, so opening the factory never runs queued work
 *     automatically; the banner says so honestly the moment it matters. Only
 *     QUEUED work counts as "waiting for resume" — leased jobs belong to a
 *     running (or crashed) owner and resume does not start them.
 *   - Hold: re-engage the gate (stop starting NEW work) while active work
 *     or runs exist.
 *   - Cancel all tasks: shown only while cancellable work exists. One guarded
 *     command that cancels every cancellable run and propagates to queued and
 *     in-flight execution work. Destructive: inline two-step confirm.
 *   - Clear everything: shown only while run history exists. Cancel-all THEN
 *     permanently delete every terminal run's ledger. Irreversible; same
 *     two-step confirm pattern.
 *   - Empty factory: a quiet "execution held/active" badge — the gate state
 *     is never hidden (truth over decoration), but it never shouts either.
 *
 * State is never optimistic: every render is derived from the polled
 * GET /api/execution projection, and mutations go through the command guard
 * (token + CSRF) exactly like the per-run command bar.
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useSession } from '../session-context';
import {
  cancelAllRuns,
  clearAllRuns,
  holdFactoryExecution,
  resumeFactoryExecution,
} from '../../lib/api-client';
import type { CancelAllRunsResult, ClearAllRunsResult, MutationResult } from '../../lib/api-client';
import { useExecutionOverview } from '../../lib/use-execution-overview';
import type { ExecutionOverview } from '../../lib/types';

type Phase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'busy'; readonly action: string }
  | { readonly kind: 'confirm-cancel-all' }
  | { readonly kind: 'confirm-clear-all' }
  | { readonly kind: 'notice'; readonly message: string }
  | { readonly kind: 'error'; readonly message: string };

export function FactoryCommandBar({
  initial,
  runCount = 0,
  cancellableRunCount = 0,
  onChanged,
}: {
  readonly initial: ExecutionOverview;
  /** Total runs on the ledger — Clear everything is pointless without any. */
  readonly runCount?: number;
  /** Non-terminal runs — Cancel all is pointless without any (or queue work). */
  readonly cancellableRunCount?: number;
  /** Called after a successful mutation so the parent reloads run state. */
  readonly onChanged?: () => void;
}) {
  const session = useSession();
  const live = useExecutionOverview(initial);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const busy = phase.kind === 'busy';
  const { execution, queue } = live.overview;
  // Cancel-all reaches queued AND leased work; resume only starts QUEUED work.
  const cancellable = queue.queued + queue.leased;
  // Contextual visibility: a queue job implies a run even if the run props
  // lag one refresh behind, so queue counts back up the run-derived counts.
  const hasQueue = cancellable > 0;
  const showCancelAll = hasQueue || cancellableRunCount > 0;
  const showClearAll = hasQueue || runCount > 0;

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
        live.refresh();
        onChanged?.();
        return;
      }
      live.refresh();
      setPhase({
        kind: 'error',
        message: result.message ?? `${action} was not accepted (${result.error}).`,
      });
    } catch (error) {
      if (cancelledRef.current) {
        return;
      }
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

  function describeClearAll(data: ClearAllRunsResult): string {
    const cleared = data.clearedCount;
    const skipped = data.skipped.length;
    const base =
      cleared === 0
        ? 'Nothing to clear — no terminal run history on the ledger.'
        : `Cleared ${cleared} run${cleared === 1 ? '' : 's'} from the ledger.`;
    return skipped > 0
      ? `${base} ${skipped} run${skipped === 1 ? ' is' : 's are'} still active and kept.`
      : base;
  }

  // A resume that leaves the daemon loop stopped is a trap: the gate is open
  // but nothing drains. Surface it as a notice instead of returning to idle.
  function describeResume(data: { running?: boolean }): string | undefined {
    return data.running === false
      ? 'Resumed, but the execution daemon is not running — queued work will not drain. Check server logs.'
      : undefined;
  }

  // Shared elements so the held banner and the active row cannot drift (the
  // server defaults the reasons to "operator cancel-all" / "operator clear-all").
  const cancelAll = (
    <ConfirmedDestructiveControl
      busy={busy}
      confirming={phase.kind === 'confirm-cancel-all'}
      busyLabel={phase.kind === 'busy' && phase.action === 'cancel all' ? 'Cancelling…' : null}
      armLabel="Cancel all tasks"
      armTestId="cancel-all-tasks"
      confirmGroupLabel="Confirm cancel all tasks"
      confirmQuestion={
        <>
          Cancel every active run
          {cancellable > 0 ? ` (${cancellable} task${cancellable === 1 ? '' : 's'} in the queue)` : ''}
          ? Queued and in-flight work stops.
        </>
      }
      confirmLabel="Confirm cancel all"
      confirmTestId="cancel-all-confirm"
      keepLabel="Keep running"
      keepTestId="cancel-all-keep"
      onArm={() => setPhase({ kind: 'confirm-cancel-all' })}
      onDisarm={() => setPhase({ kind: 'idle' })}
      onConfirm={() => void perform('cancel all', () => cancelAllRuns(session), describeCancelAll)}
    />
  );
  const clearAll = (
    <ConfirmedDestructiveControl
      busy={busy}
      confirming={phase.kind === 'confirm-clear-all'}
      busyLabel={phase.kind === 'busy' && phase.action === 'clear all' ? 'Clearing…' : null}
      armLabel="Clear everything"
      armTestId="clear-all-tasks"
      confirmGroupLabel="Confirm clear everything"
      confirmQuestion={
        <>
          Permanently delete ALL run history? Active runs are cancelled first; finished, failed,
          and cancelled runs are erased from the ledger. This cannot be undone.
        </>
      }
      confirmLabel="Confirm clear everything"
      confirmTestId="clear-all-confirm"
      keepLabel="Keep history"
      keepTestId="clear-all-keep"
      onArm={() => setPhase({ kind: 'confirm-clear-all' })}
      onDisarm={() => setPhase({ kind: 'idle' })}
      onConfirm={() => void perform('clear all', () => clearAllRuns(session), describeClearAll)}
    />
  );

  return (
    <section
      className="stack"
      aria-label="Factory execution controls"
      style={{ gap: 'var(--space-4)' }}
    >
      {execution.held ? (
        hasQueue ? (
          // Held work is actually waiting: this is the loud moment the gate
          // banner exists for, with Resume as the single explicit release.
          <div className="banner banner--warn" role="status" data-testid="factory-held-banner">
            <span className="banner__body">
              Execution is held — nothing runs automatically.
              {queue.queued > 0
                ? ` ${queue.queued} task${queue.queued === 1 ? ' is' : 's are'} waiting for your resume.`
                : ' Queued work will wait for your resume.'}
              {queue.leased > 0
                ? ` ${queue.leased} leased task${queue.leased === 1 ? '' : 's'} belong${queue.leased === 1 ? 's' : ''} to a running or previous owner — resume does not start them.`
                : ''}
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
              {phase.kind === 'busy' && phase.action === 'resume'
                ? 'Resuming…'
                : 'Resume execution'}
            </button>
            {cancelAll}
            {clearAll}
            {live.reconnecting ? <span className="badge sev-warn">reconnecting</span> : null}
          </div>
        ) : (
          // Nothing queued: the gate state stays visible but quiet, and the
          // destructive controls appear only when history/runs exist for them.
          <div className="row" role="group" aria-label="Factory-wide execution commands">
            <span className="badge" data-testid="factory-held-badge">
              execution held — runs start only after you resume
            </span>
            {showCancelAll ? cancelAll : null}
            {showClearAll ? clearAll : null}
            {live.reconnecting ? <span className="badge sev-warn">reconnecting</span> : null}
          </div>
        )
      ) : (
        <div className="row" role="group" aria-label="Factory-wide execution commands">
          <span className="badge" data-testid="factory-active-badge">
            execution active
          </span>
          {hasQueue || runCount > 0 ? (
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              disabled={busy}
              data-testid="factory-hold"
              onClick={() => void perform('hold', () => holdFactoryExecution(session))}
            >
              {phase.kind === 'busy' && phase.action === 'hold' ? 'Holding…' : 'Hold new work'}
            </button>
          ) : null}
          {showCancelAll ? cancelAll : null}
          {showClearAll ? clearAll : null}
          {live.reconnecting ? <span className="badge sev-warn">reconnecting</span> : null}
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
 * A destructive control with its inline two-step confirm — shared by
 * cancel-all and clear-everything so both render the exact same behavior.
 * Keyboard contract: arming moves focus to the SAFE "keep" option, Escape
 * disarms, and closing the confirm (either way) returns focus to the arm
 * button so keyboard users never lose their place.
 */
function ConfirmedDestructiveControl({
  busy,
  confirming,
  busyLabel,
  armLabel,
  armTestId,
  confirmGroupLabel,
  confirmQuestion,
  confirmLabel,
  confirmTestId,
  keepLabel,
  keepTestId,
  onArm,
  onDisarm,
  onConfirm,
}: {
  readonly busy: boolean;
  readonly confirming: boolean;
  /** Label shown while THIS control's command is in flight (null when idle). */
  readonly busyLabel: string | null;
  readonly armLabel: string;
  readonly armTestId: string;
  readonly confirmGroupLabel: string;
  readonly confirmQuestion: ReactNode;
  readonly confirmLabel: string;
  readonly confirmTestId: string;
  readonly keepLabel: string;
  readonly keepTestId: string;
  readonly onArm: () => void;
  readonly onDisarm: () => void;
  readonly onConfirm: () => void;
}) {
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
        aria-label={confirmGroupLabel}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            onDisarm();
          }
        }}
      >
        <span className="sev-warn" style={{ fontSize: 'var(--fs-2xs)' }}>
          {confirmQuestion}
        </span>
        <button
          type="button"
          className="btn btn--sm btn--danger"
          data-testid={confirmTestId}
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
        <button
          ref={keepRef}
          type="button"
          className="btn btn--sm btn--ghost"
          data-testid={keepTestId}
          onClick={onDisarm}
        >
          {keepLabel}
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
      data-testid={armTestId}
      onClick={onArm}
    >
      {busyLabel ?? armLabel}
    </button>
  );
}
