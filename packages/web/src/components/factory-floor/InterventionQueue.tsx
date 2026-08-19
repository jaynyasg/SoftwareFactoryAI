'use client';

/**
 * InterventionQueue — the cross-run operator intervention queue (DESIGN.md §5,
 * U9; CEO expansion X4). Everything a human must decide, across ALL runs,
 * always rendered FIRST in the operator hierarchy. Filterable by run,
 * severity, blocking stage, and required-action text; every item links back to
 * its run's ledger (the raising sequence) and offers focus + guarded resolve.
 * The empty queue is a designed feature state — the factory running clean is
 * information, not an absence.
 */
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type { EventSeverity } from '@software-factory/core';
import type { InterventionItem, InterventionQueueSnapshot } from '../../lib/types';
import { filterInterventionItems } from '../../lib/run-view';
import { resolveInterventionItem } from '../../lib/api-client';
import { useSession } from '../session-context';
import { Mono, SeverityBadge } from './primitives';

const SEVERITIES: readonly EventSeverity[] = ['info', 'warn', 'error', 'critical'];

function ResolveControl({
  item,
  onResolved,
}: {
  readonly item: InterventionItem;
  readonly onResolved?: () => void;
}) {
  const session = useSession();
  const [open, setOpen] = useState(false);
  const [resolution, setResolution] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    const trimmed = resolution.trim();
    if (trimmed.length === 0) {
      setError('State how this was resolved — the resolution is recorded on the ledger.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await resolveInterventionItem(session, item.interventionId, {
        resolution: trimmed,
      });
      if (result.ok) {
        setOpen(false);
        onResolved?.();
      } else {
        setError(result.message ?? `Resolve failed (${result.error}).`);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Network error resolving.');
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        className="btn btn--sm"
        onClick={() => setOpen(true)}
        aria-label={`Resolve intervention ${item.interventionId}`}
      >
        Resolve
      </button>
    );
  }
  return (
    <span className="iq__resolve">
      <input
        className="input iq__resolve-input"
        placeholder="How was this resolved?"
        value={resolution}
        onChange={(e) => setResolution(e.target.value)}
        aria-label={`Resolution for ${item.interventionId}`}
      />
      <button
        type="button"
        className="btn btn--sm btn--primary"
        disabled={busy}
        onClick={() => void submit()}
      >
        {busy ? 'Recording…' : 'Record'}
      </button>
      <button type="button" className="btn btn--sm btn--ghost" onClick={() => setOpen(false)}>
        Keep open
      </button>
      {error !== null ? (
        <span className="sev-error" role="alert" style={{ fontSize: 'var(--fs-2xs)' }}>
          {error}
        </span>
      ) : null}
    </span>
  );
}

export function InterventionQueue({
  snapshot,
  reconnecting = false,
  focusedRunId,
  onFocusRun,
  onResolved,
}: {
  readonly snapshot: InterventionQueueSnapshot;
  readonly reconnecting?: boolean;
  readonly focusedRunId?: string | null;
  /** Focus the blueprint on this item's run (never switches silently). */
  readonly onFocusRun?: (runId: string) => void;
  readonly onResolved?: () => void;
}) {
  const [runFilter, setRunFilter] = useState('all');
  const [severityFilter, setSeverityFilter] = useState('all');
  const [stageFilter, setStageFilter] = useState('all');
  const [actionFilter, setActionFilter] = useState('');
  const [showResolved, setShowResolved] = useState(false);

  const runIds = useMemo(
    () => [...new Set(snapshot.interventions.map((item) => item.runId))],
    [snapshot.interventions],
  );
  const stages = useMemo(
    () => [...new Set(snapshot.interventions.map((item) => item.blockingStage))],
    [snapshot.interventions],
  );

  // A run filter must never outlive its run: when the filtered run disappears
  // from the polled snapshot, a stale filter would silently hide every item.
  // Reset to 'all' so the queue stays honest.
  useEffect(() => {
    if (runFilter !== 'all' && !runIds.includes(runFilter)) {
      setRunFilter('all');
    }
  }, [runFilter, runIds]);

  const items = filterInterventionItems(snapshot.interventions, {
    runId: runFilter === 'all' ? undefined : runFilter,
    severity: severityFilter === 'all' ? undefined : (severityFilter as EventSeverity),
    blockingStage: stageFilter === 'all' ? undefined : stageFilter,
    actionText: actionFilter,
    openOnly: !showResolved,
  });

  return (
    <section className="panel iq" aria-label="Operator interventions">
      <header className="panel__header">
        <div className="row" style={{ gap: 'var(--space-8)' }}>
          <h2 className="panel__title">Needs you</h2>
          <span className="panel__hint">
            {snapshot.openCount} open across {runIds.length} run{runIds.length === 1 ? '' : 's'}
          </span>
        </div>
        {reconnecting ? (
          <span className="badge sev-warn" data-testid="iq-reconnecting">
            reconnecting
          </span>
        ) : null}
      </header>
      <div className="panel__body">
        {snapshot.interventions.length > 0 ? (
          <div className="iq__filters" aria-label="Intervention filters">
            <select
              className="select select--sm"
              value={runFilter}
              onChange={(e) => setRunFilter(e.target.value)}
              aria-label="Filter interventions by run"
            >
              <option value="all">all runs</option>
              {runIds.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
            <select
              className="select select--sm"
              value={severityFilter}
              onChange={(e) => setSeverityFilter(e.target.value)}
              aria-label="Filter interventions by severity"
            >
              <option value="all">any severity</option>
              {SEVERITIES.map((sev) => (
                <option key={sev} value={sev}>
                  {sev}
                </option>
              ))}
            </select>
            <select
              className="select select--sm"
              value={stageFilter}
              onChange={(e) => setStageFilter(e.target.value)}
              aria-label="Filter interventions by blocking stage"
            >
              <option value="all">any stage</option>
              {stages.map((stage) => (
                <option key={stage} value={stage}>
                  {stage}
                </option>
              ))}
            </select>
            <input
              className="input select--sm iq__filter--grow"
              placeholder="filter by required action…"
              value={actionFilter}
              onChange={(e) => setActionFilter(e.target.value)}
              aria-label="Filter interventions by required action"
            />
            <label className="iq__filter--toggle">
              <input
                type="checkbox"
                checked={showResolved}
                onChange={(e) => setShowResolved(e.target.checked)}
              />
              <span className="label">show resolved</span>
            </label>
          </div>
        ) : null}

        {items.length === 0 ? (
          <div className="state-block iq__empty" data-testid="interventions-empty">
            <span className="state-block__title">
              {snapshot.openCount === 0
                ? 'Nothing needs you — the factory is running clean.'
                : 'Nothing matches these filters.'}
            </span>
            <span className="muted">
              {snapshot.openCount === 0
                ? snapshot.interventions.length === 0
                  ? 'Approvals, missing credentials, blocked stages, and retry decisions will appear here the moment a run needs a human — across every run.'
                  : `${snapshot.interventions.length} resolved intervention(s) are hidden — turn on "show resolved" for the history.`
                : `${snapshot.openCount} open intervention(s) are hidden by the current filters — clear them to see what needs you.`}
            </span>
          </div>
        ) : (
          <ul className="iq__list" data-testid="intervention-list">
            {items.map((item) => (
              <li
                key={item.interventionId}
                className="iq__item"
                data-testid="intervention-item"
                data-run-id={item.runId}
              >
                <div className="iq__item-head">
                  <SeverityBadge severity={item.severity} label={item.kind.replace(/_/g, ' ')} />
                  <span className="badge">{item.blockingStage}</span>
                  {item.status === 'resolved' ? (
                    <span className="badge sev-success">
                      <span className="badge__dot" aria-hidden="true" />
                      resolved{item.resolution !== undefined ? `: ${item.resolution}` : ''}
                    </span>
                  ) : null}
                  <span className="iq__item-reason">{item.reason}</span>
                </div>
                <p className="iq__item-action">{item.requiredAction}</p>
                <div className="iq__item-foot">
                  <span className="row" style={{ gap: 'var(--space-4)' }}>
                    <span className="label">run</span>
                    <Mono value={item.runId} max={22} copyable={false} />
                    <span className="mono muted" title="ledger sequence of intervention.raised">
                      seq {item.sequence}
                    </span>
                  </span>
                  <span className="row" style={{ flex: 'none', gap: 'var(--space-4)' }}>
                    <Link
                      className="btn btn--sm btn--ghost"
                      href={`/runs/${encodeURIComponent(item.runId)}`}
                      aria-label={`Open ledger evidence for ${item.interventionId}`}
                    >
                      Ledger
                    </Link>
                    {onFocusRun !== undefined && item.runId !== focusedRunId ? (
                      <button
                        type="button"
                        className="btn btn--sm btn--ghost"
                        onClick={() => onFocusRun(item.runId)}
                        aria-label={`Focus run ${item.runId}`}
                      >
                        Focus
                      </button>
                    ) : null}
                    {item.status === 'open' ? (
                      <ResolveControl item={item} onResolved={onResolved} />
                    ) : null}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
