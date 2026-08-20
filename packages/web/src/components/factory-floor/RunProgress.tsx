'use client';

/**
 * RunProgress — the at-a-glance execution banner answering the operator's
 * first two questions: WHAT is being built right now, and HOW FAR along is
 * the run? A ticket progress bar (completed / total, failures tinted), the
 * currently-running ticket(s) by name, and the latest live worker action
 * straight from the ledger (`worker.progress` detail). Purely projected —
 * renders nothing before a plan exists.
 */
import type { ReactNode } from 'react';
import type { TicketView } from '@software-factory/core';
import type { LedgerRow } from '@software-factory/core';

const RUNNING_STATES = new Set(['running', 'retrying']);
const FAILED_STATES = new Set(['failed', 'dead_lettered', 'blocked']);

export function RunProgress({
  tickets,
  rows,
  headerAction,
  executionState,
  executionReason,
  openDecisionCount = 0,
  decisionsHref,
}: {
  readonly tickets: readonly TicketView[];
  readonly rows: readonly LedgerRow[];
  /** Prominent action rendered in the banner header (e.g. "Open full run"). */
  readonly headerAction?: ReactNode;
  /** Projected execution state — blocked/failed renders the alert strip. */
  readonly executionState?: string;
  readonly executionReason?: string;
  /** OPEN interventions on this run — anything a human must decide. */
  readonly openDecisionCount?: number;
  /** In-page anchor of the decision surface ("Needs you" / "Decisions needed"). */
  readonly decisionsHref?: string;
}) {
  if (tickets.length === 0) {
    return null;
  }
  const total = tickets.length;
  const completed = tickets.filter((t) => t.state === 'completed').length;
  const failed = tickets.filter((t) => FAILED_STATES.has(t.state)).length;
  const running = tickets.filter((t) => RUNNING_STATES.has(t.state));
  const percent = Math.round((completed / total) * 100);

  // The newest live worker action (the codex/claude adapters stream one
  // progress event per tool/command); fall back to any worker event.
  const latest = [...rows]
    .reverse()
    .find((row) => row.type === 'worker.progress' && row.detail !== undefined && row.detail.length > 0);

  return (
    <section className="panel run-progress" aria-label="Build progress" data-testid="run-progress">
      <header className="panel__header">
        <h2 className="panel__title">Build progress</h2>
        <span className="row" style={{ gap: 'var(--space-8)' }}>
          <span className="panel__hint" data-testid="run-progress-count">
            {completed} of {total} tickets completed
            {failed > 0 ? ` · ${failed} failed/blocked` : ''}
          </span>
          {headerAction}
        </span>
      </header>
      <div className="panel__body">
        {openDecisionCount > 0 || executionState === 'blocked' || executionState === 'failed' ? (
          <div
            className="banner banner--error run-progress__alert"
            role="alert"
            data-testid="run-progress-alert"
          >
            <span className="banner__body">
              <strong>
                {openDecisionCount > 0
                  ? `${openDecisionCount} decision${openDecisionCount === 1 ? '' : 's'} need${openDecisionCount === 1 ? 's' : ''} you`
                  : `Execution ${executionState}`}
                {' — '}
              </strong>
              {executionReason ?? 'the run cannot continue until this is resolved.'}
            </span>
            {decisionsHref !== undefined && openDecisionCount > 0 ? (
              <a className="btn btn--sm" href={decisionsHref}>
                Review now
              </a>
            ) : null}
          </div>
        ) : null}
        <div
          className="run-progress__bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={completed}
          aria-label={`${completed} of ${total} tickets completed`}
        >
          <div
            className={`run-progress__fill${failed > 0 ? ' run-progress__fill--warn' : ''}`}
            style={{ width: `${Math.max(percent, completed > 0 ? 4 : 0)}%` }}
          />
        </div>
        {running.length > 0 ? (
          <div className="row run-progress__now" data-testid="run-progress-now">
            <span className="label">now building</span>
            {running.map((ticket) => (
              <span key={ticket.ticketId} className="badge sev-info">
                <span className="badge__dot" aria-hidden="true" />
                {ticket.title ?? ticket.ticketId}
                {ticket.state === 'retrying' ? ' (retrying)' : ''}
              </span>
            ))}
          </div>
        ) : (
          <p className="muted" style={{ fontSize: 'var(--fs-2xs)', margin: 0 }}>
            {completed === total
              ? 'All tickets completed.'
              : 'No ticket is executing right now.'}
          </p>
        )}
        {latest !== undefined ? (
          <p className="run-progress__action mono" data-testid="run-progress-action">
            <span className="label">latest action</span>{' '}
            {latest.detail!.length > 120 ? `${latest.detail!.slice(0, 119)}…` : latest.detail}
            <span className="muted"> · {new Date(latest.timestamp).toLocaleTimeString()}</span>
          </p>
        ) : null}
      </div>
    </section>
  );
}
