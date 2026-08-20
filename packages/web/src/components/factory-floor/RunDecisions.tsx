'use client';

/**
 * RunDecisions — the decision surface for ONE run (X4 companion). Every OPEN
 * intervention blocking this run renders as an explicit decision card: what
 * stage is blocked, why, the concrete fix, and the guarded Resolve control
 * that records the operator's decision on the ledger. The panel renders
 * nothing when no decision is pending — its absence means nothing on this run
 * needs a human. The cross-run "Needs you" queue on the factory floor stays
 * the aggregate view; this panel puts the SAME resolve affordance next to the
 * run's own evidence, because the run page has no queue and decisions were
 * otherwise invisible there.
 */
import { useState } from 'react';
import type { BlockedStageView } from '../../lib/run-view';
import { materializeRunWorkspace, resolveInterventionItem } from '../../lib/api-client';
import { useSession } from '../session-context';
import { SeverityBadge } from './primitives';

/**
 * Whether an intervention is the preflight workspace check's — the one failure
 * with a one-click server action (POST /api/runs/:id/workspace). The preflight
 * workspace probe is the only raiser of source_choice/unsafe_path on the
 * preflight stage.
 */
function isWorkspaceDecision(item: BlockedStageView): boolean {
  return (
    item.blockingStage === 'preflight' &&
    (item.kind === 'source_choice' || item.kind === 'unsafe_path')
  );
}

/** One-click workspace materialization for a workspace preflight decision. */
function MaterializeWorkspaceControl({
  runId,
  onDone,
}: {
  readonly runId: string;
  readonly onDone?: () => void;
}) {
  const session = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await materializeRunWorkspace(session, runId);
      if (result.ok) {
        onDone?.();
      } else {
        setError(result.message ?? `Materialization failed (${result.error}).`);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Network error materializing.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="btn btn--sm btn--primary"
        disabled={busy}
        onClick={() => void submit()}
        aria-label={`Materialize workspace for run ${runId}`}
      >
        {busy ? 'Materializing…' : 'Materialize workspace'}
      </button>
      {error !== null ? (
        <span className="sev-error" role="alert" style={{ fontSize: 'var(--fs-2xs)' }}>
          {error}
        </span>
      ) : null}
    </>
  );
}

/**
 * The guarded resolve control shared by the cross-run queue and the per-run
 * decision panel: open → state HOW it was resolved → record on the ledger.
 */
export function ResolveInterventionControl({
  interventionId,
  onResolved,
}: {
  readonly interventionId: string;
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
      const result = await resolveInterventionItem(session, interventionId, {
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
        aria-label={`Resolve intervention ${interventionId}`}
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
        aria-label={`Resolution for ${interventionId}`}
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

export function RunDecisions({
  runId,
  interventions,
  onResolved,
}: {
  readonly runId: string;
  /** OPEN interventions blocking this run (the run aggregate's projection). */
  readonly interventions: readonly BlockedStageView[];
  readonly onResolved?: () => void;
}) {
  if (interventions.length === 0) {
    return null;
  }
  return (
    <section
      className="panel run-decisions"
      id="run-decisions"
      aria-label="Decisions needed"
      data-testid="run-decisions"
    >
      <header className="panel__header">
        <h2 className="panel__title">Decisions needed</h2>
        <span className="panel__hint">
          {interventions.length} open — execution stays blocked until each is resolved
        </span>
      </header>
      <div className="panel__body">
        <ul className="run-decisions__list">
          {interventions.map((item) => (
            <li
              key={item.interventionId}
              className="run-decisions__item"
              data-testid="run-decision"
            >
              <div className="row" style={{ gap: 'var(--space-8)' }}>
                <SeverityBadge severity={item.severity} label={item.kind.replace(/_/g, ' ')} />
                <span className="badge">{item.blockingStage}</span>
                <span className="run-decisions__reason">{item.reason}</span>
              </div>
              <p className="run-decisions__fix">
                <span className="label">fix</span>
                <span>{item.requiredAction}</span>
              </p>
              <div className="row" style={{ gap: 'var(--space-4)' }}>
                {isWorkspaceDecision(item) ? (
                  <MaterializeWorkspaceControl runId={runId} onDone={onResolved} />
                ) : null}
                <ResolveInterventionControl
                  interventionId={item.interventionId}
                  onResolved={onResolved}
                />
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
