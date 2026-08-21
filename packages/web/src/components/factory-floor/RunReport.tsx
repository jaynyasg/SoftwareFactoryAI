'use client';

/**
 * RunReport — the completion report for a finished run. Renders once
 * `run.status === 'completed'`: what was built (tickets, gates, duration,
 * adapter/model, workspace), and the ship-it actions — publish the checkout
 * to GitHub (recorded as `workspace.published`), plus HONEST deploy status
 * (a run without a deploy ticket did not deploy; hosted deploy needs the
 * Render + git destination setup).
 */
import { useState } from 'react';
import type { LedgerRow, RunProjection, TicketView } from '@software-factory/core';
import type { DeployView, GateOutcomeRow } from '../../lib/run-view';
import { publishRunWorkspace } from '../../lib/api-client';
import type { PublishRunResult } from '../../lib/api-client';
import { useSession } from '../session-context';
import { Mono, SeverityBadge } from './primitives';

/** One milestone in the build story, derived purely from ledger rows. */
interface StoryEntry {
  readonly at: number;
  readonly label: string;
  readonly detail?: string;
  readonly severity: 'info' | 'warn' | 'success';
}

/**
 * Derive the build's NARRATIVE from the ledger: creation, planning decisions,
 * rehearsals, workspace, course-changes (adapter/model overrides), adversity
 * overcome (failed attempts), ticket flow, gates, publish, completion. Every
 * entry traces to a recorded event — the story is the ledger, retold.
 */
function deriveStory(rows: readonly LedgerRow[]): StoryEntry[] {
  const story: StoryEntry[] = [];
  const push = (row: LedgerRow, label: string, severity: StoryEntry['severity'] = 'info') =>
    story.push({ at: row.timestamp, label, detail: row.detail, severity });

  for (const row of rows) {
    switch (row.type) {
      case 'run.created':
        push(row, 'Run created');
        break;
      case 'supervisor.decision':
        push(row, 'Supervisor decision');
        break;
      case 'run.planned':
        push(row, 'Plan recorded');
        break;
      case 'preflight.passed':
        push(row, 'Dry-run rehearsal passed', 'success');
        break;
      case 'preflight.failed':
        push(row, 'Dry-run rehearsal blocked', 'warn');
        break;
      case 'workspace.checkout_completed':
        push(row, 'Workspace checked out', 'success');
        break;
      case 'workspace.local_bound':
        push(row, 'Local folder bound as workspace', 'success');
        break;
      case 'run.settings_overridden':
        push(row, 'Operator changed course (adapter/model override)', 'warn');
        break;
      case 'execution.failed':
        push(row, 'Execution attempt failed — recovered later', 'warn');
        break;
      case 'worker.completed':
        if (row.ticketId !== undefined) {
          push(row, `Ticket completed: ${row.ticketId}`, 'success');
        }
        break;
      case 'gate.failed':
        push(row, `Gate failed: ${row.ticketId ?? 'post-run'}`, 'warn');
        break;
      case 'workspace.published':
        push(row, 'Deliverable published to GitHub', 'success');
        break;
      case 'run.completed':
        push(row, 'Run completed', 'success');
        break;
      default:
        break;
    }
  }
  return story;
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  const seconds = Math.floor((ms % 60_000) / 1000);
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

type PublishPhase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'busy' }
  | { readonly kind: 'done'; readonly result: PublishRunResult }
  | { readonly kind: 'error'; readonly message: string };

export function RunReport({
  run,
  tickets,
  gates,
  rows,
  deploy,
}: {
  readonly run: RunProjection;
  readonly tickets: readonly TicketView[];
  readonly gates: readonly GateOutcomeRow[];
  readonly rows: readonly LedgerRow[];
  readonly deploy?: DeployView;
}) {
  const session = useSession();
  const [publish, setPublish] = useState<PublishPhase>({ kind: 'idle' });

  if (run.status !== 'completed') {
    return null;
  }

  const runId = run.runId ?? 'unknown';
  const completedTickets = tickets.filter((t) => t.state === 'completed').length;
  const gatesPassed = gates.filter((g) => g.status === 'passed').length;
  const gatesFailed = gates.filter((g) => g.status === 'failed').length;
  const createdAt = rows.find((r) => r.type === 'run.created')?.timestamp;
  const completedAt = [...rows].reverse().find((r) => r.type === 'run.completed')?.timestamp;
  const duration =
    createdAt !== undefined && completedAt !== undefined && completedAt > createdAt
      ? formatDuration(completedAt - createdAt)
      : undefined;
  const published = [...rows]
    .reverse()
    .find((r) => r.type === 'workspace.published') as (LedgerRow & { payload?: unknown }) | undefined;
  const deployed = deploy !== undefined && deploy.status !== 'idle';

  async function onPublish(): Promise<void> {
    setPublish({ kind: 'busy' });
    try {
      const result = await publishRunWorkspace(session, runId);
      if (result.ok) {
        setPublish({ kind: 'done', result: result.data });
      } else {
        setPublish({
          kind: 'error',
          message: result.message ?? `Publish was not accepted (${result.error}).`,
        });
      }
    } catch (error) {
      setPublish({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Network error while publishing.',
      });
    }
  }

  const story = deriveStory(rows);

  return (
    <section
      className="panel run-report"
      id="run-report"
      aria-label="Build report"
      data-testid="run-report"
    >
      <header className="panel__header">
        <h2 className="panel__title">Build report</h2>
        <SeverityBadge severity="success" label="run completed" />
      </header>
      <div className="panel__body">
        <div className="row" style={{ gap: 'var(--space-8)', flexWrap: 'wrap' }}>
          <span className="badge sev-success">
            {completedTickets}/{tickets.length} tickets completed
          </span>
          <span className={`badge ${gatesFailed > 0 ? 'sev-warn' : 'sev-success'}`}>
            gates {gatesPassed} passed{gatesFailed > 0 ? ` · ${gatesFailed} failed` : ''}
          </span>
          {duration !== undefined ? <span className="badge">duration {duration}</span> : null}
          {run.selectedAdapter ? <span className="badge">adapter {run.selectedAdapter}</span> : null}
          {run.modelProfile ? <span className="badge">model {run.modelProfile}</span> : null}
        </div>

        {run.buildContract?.workspace ? (
          <div className="row">
            <span className="label">deliverable</span>
            <Mono value={run.buildContract.workspace} max={56} />
          </div>
        ) : null}

        {tickets.length > 0 ? (
          <div className="stack" style={{ gap: 'var(--space-4)' }} data-testid="run-report-tickets">
            <span className="label">tickets</span>
            <ul className="run-report__tickets">
              {tickets.map((ticket) => {
                const started = rows.find(
                  (r) => r.type === 'worker.started' && r.ticketId === ticket.ticketId,
                )?.timestamp;
                const finished = [...rows]
                  .reverse()
                  .find(
                    (r) => r.type === 'worker.completed' && r.ticketId === ticket.ticketId,
                  )?.timestamp;
                const took =
                  started !== undefined && finished !== undefined && finished > started
                    ? formatDuration(finished - started)
                    : undefined;
                return (
                  <li key={ticket.ticketId} className="run-report__ticket">
                    <SeverityBadge
                      severity={
                        ticket.state === 'completed'
                          ? 'success'
                          : ticket.state === 'failed' || ticket.state === 'blocked'
                            ? 'error'
                            : 'info'
                      }
                      label={ticket.state}
                    />
                    <span className="mono run-report__ticket-id">{ticket.ticketId}</span>
                    <span className="run-report__ticket-title">{ticket.title ?? ''}</span>
                    <span className="muted run-report__ticket-meta">
                      {ticket.riskTier ? `${ticket.riskTier} risk` : ''}
                      {ticket.attempts > 1 ? ` · ${ticket.attempts} attempts` : ''}
                      {took !== undefined ? ` · ${took}` : ''}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}

        {story.length > 0 ? (
          <details className="run-report__story" data-testid="run-report-story" open>
            <summary className="label">build story · {story.length} milestones</summary>
            <ol className="run-report__timeline">
              {story.map((entry, index) => (
                <li key={`${entry.at}-${index}`} className={`run-report__milestone sev-${entry.severity}`}>
                  <span className="run-report__time mono">{formatTime(entry.at)}</span>
                  <span className="run-report__milestone-label">{entry.label}</span>
                  {entry.detail ? (
                    <span className="muted run-report__milestone-detail">{entry.detail}</span>
                  ) : null}
                </li>
              ))}
            </ol>
          </details>
        ) : null}

        <div className="stack" style={{ gap: 'var(--space-4)' }} data-testid="run-report-ship">
          <span className="label">ship it</span>
          {run.githubRepo ? (
            <div className="row" style={{ gap: 'var(--space-8)' }}>
              {publish.kind === 'done' ? (
                <span className="badge sev-success" data-testid="publish-result">
                  {publish.result.result.pushed
                    ? `pushed ${publish.result.result.commit?.slice(0, 10) ?? ''} → ${publish.result.repo}@${publish.result.result.branch}`
                    : (publish.result.result.note ?? 'nothing to publish')}
                </span>
              ) : (
                <button
                  type="button"
                  className="btn btn--sm btn--primary"
                  disabled={publish.kind === 'busy'}
                  onClick={() => void onPublish()}
                  aria-label={`Publish run ${runId} to GitHub`}
                >
                  {publish.kind === 'busy'
                    ? 'Publishing…'
                    : published !== undefined
                      ? 'Publish to GitHub again'
                      : 'Publish to GitHub'}
                </button>
              )}
              {publish.kind === 'error' ? (
                <span className="sev-error" role="alert" style={{ fontSize: 'var(--fs-2xs)' }}>
                  {publish.message}
                </span>
              ) : null}
            </div>
          ) : (
            <span className="muted" style={{ fontSize: 'var(--fs-2xs)' }}>
              No GitHub repository is attached to this run — the deliverable lives in the local
              workspace only.
            </span>
          )}
          <span
            className="muted"
            style={{ fontSize: 'var(--fs-2xs)' }}
            data-testid="run-report-deploy"
          >
            {deployed
              ? `Hosted deploy: ${deploy?.status}.`
              : 'This run did not deploy (its plan had no deploy ticket). Hosted deploy needs the Render + git destination setup — see the Setup checklist on the factory floor.'}
          </span>
        </div>
      </div>
    </section>
  );
}
