/**
 * ReviewStudio — the risk-tiered review surface (DESIGN.md §5; Ash mapping).
 *
 * Brings together the risk tier, command-guarded decision cards, a trace
 * severity summary, artifact confidence, and provenance so a human can decide
 * whether to trust the work. Pending reviews render as DecisionCards; decided
 * reviews show their recorded outcome.
 *
 * U7 additions:
 *  - STAGE reviews (`review.requested` with `stage: gates|execution`) render a
 *    DecisionCard in every mode and at every risk tier — approving one resumes
 *    the blocked stage server-side (gate re-run / execution retry).
 *  - BLOCKED STAGES list the run's open interventions. Approvable kinds point
 *    at the pending stage review; policy blocks are explicitly marked as NOT
 *    approvable (KTD6 — no mode can approve through them).
 *  - GATE EVIDENCE shows the latest outcome per gate (stage, attempts, and the
 *    recorded pass summary / failure reason) plus repair-loop counters, so a
 *    failed run explains itself without opening raw JSON.
 */
import type { ArtifactView, OperatorSeverityCounts } from '@software-factory/core';
import type {
  BlockedStageView,
  GateOutcomeRow,
  RepairSummaryRow,
  ReviewItem,
} from '../../lib/run-view';
import type { ReviewMode } from '@software-factory/core';
import { DecisionCard } from './DecisionCard';
import { ArtifactConfidence } from './ArtifactConfidence';

function gateStatusClass(status: GateOutcomeRow['status']): string {
  switch (status) {
    case 'passed':
      return 'sev-success';
    case 'failed':
      return 'sev-error';
    default:
      return 'sev-info';
  }
}

export function ReviewStudio({
  runId,
  reviewMode,
  expectedVersion,
  reviews,
  artifacts,
  counts,
  gates = [],
  repairs = [],
  blockedStages = [],
  reducedTrust = false,
  onReload,
}: {
  readonly runId: string;
  readonly reviewMode: ReviewMode;
  readonly expectedVersion: number;
  readonly reviews: readonly ReviewItem[];
  readonly artifacts: readonly ArtifactView[];
  readonly counts: OperatorSeverityCounts;
  /** Latest gate outcomes for the run (U7). */
  readonly gates?: readonly GateOutcomeRow[];
  /** Ledger-derived repair-loop summaries (U7). */
  readonly repairs?: readonly RepairSummaryRow[];
  /** OPEN interventions blocking this run's stages (U7). */
  readonly blockedStages?: readonly BlockedStageView[];
  readonly reducedTrust?: boolean;
  readonly onReload?: () => void;
}) {
  // Stage reviews are the approval lever for blocked gate/execution stages:
  // they render in EVERY mode and at every tier. Plain risk-tier reviews keep
  // the original rule (human mode, high risk only).
  const pending = reviews.filter(
    (review) =>
      review.status === 'pending' &&
      (review.stage !== undefined || (reviewMode === 'human' && review.riskTier === 'high')),
  );
  const decided = reviews.filter((review) => review.status !== 'pending');

  return (
    <section className="panel" aria-label="Review studio">
      <header className="panel__header">
        <h2 className="panel__title">Review studio</h2>
        <span className="panel__hint">mode: {reviewMode}</span>
      </header>
      <div className="panel__body">
        <div className="row" aria-label="trace severity summary">
          <span className="label">trace severity</span>
          <span className="badge sev-warn">{counts.warn} warn</span>
          <span className="badge sev-error">{counts.error} error</span>
          <span className="badge sev-critical">{counts.critical} critical</span>
        </div>

        {reducedTrust ? (
          <div className="banner banner--warn" role="status" data-testid="reduced-trust">
            <span className="banner__body">
              Reduced-trust: a sandbox fallback was used in this run — weigh artifacts accordingly.
            </span>
          </div>
        ) : null}

        {blockedStages.length > 0 ? (
          <div className="stack" aria-label="blocked stages">
            <span className="label">blocked stages</span>
            {blockedStages.map((item) => (
              <div
                key={item.interventionId}
                className={`banner ${item.approvable ? 'banner--warn' : 'banner--error'}`}
                data-testid="blocked-stage"
              >
                <span className="banner__body">
                  <span className="badge">{item.blockingStage}</span>{' '}
                  <span className="badge">{item.kind}</span> {item.reason}
                  <br />
                  <span className="muted">{item.requiredAction}</span>
                  {item.approvable ? null : (
                    <>
                      <br />
                      <strong data-testid="policy-blocked">
                        Policy-blocked — cannot be approved through review (any mode).
                      </strong>
                    </>
                  )}
                </span>
              </div>
            ))}
          </div>
        ) : null}

        <div className="stack">
          <span className="label">pending decisions</span>
          {pending.length === 0 ? (
            <p className="muted">No reviews are waiting on a human right now.</p>
          ) : (
            pending.map((review) => (
              <DecisionCard
                key={review.sequence}
                runId={runId}
                riskTier={review.riskTier}
                expectedVersion={expectedVersion}
                reviewMode={reviewMode}
                summary={
                  review.stage !== undefined
                    ? `${review.summary ?? 'Blocked stage awaiting approval.'} (approving resumes the ${review.stage} stage)`
                    : review.summary
                }
                evidence={review.evidence}
                onReload={onReload}
              />
            ))
          )}
        </div>

        {gates.length > 0 ? (
          <div className="stack" aria-label="gate evidence">
            <span className="label">gates</span>
            <ul className="gate-list">
              {gates.map((gate) => (
                <li
                  key={`${gate.ticketId ?? 'run'}-${gate.gate}`}
                  className="gate-list__row"
                  data-testid="gate-row"
                >
                  <span className={`badge ${gateStatusClass(gate.status)}`}>
                    <span className="badge__dot" aria-hidden="true" />
                    {gate.status}
                  </span>
                  <span className="gate-list__name">{gate.gate}</span>
                  {gate.stage !== undefined ? (
                    <span className="badge">{gate.stage.replace('_', '-')}</span>
                  ) : null}
                  {gate.ticketId !== undefined ? (
                    <span className="badge mono">{gate.ticketId}</span>
                  ) : null}
                  {gate.attempts > 1 ? (
                    <span className="badge">{gate.attempts} attempts</span>
                  ) : null}
                  {gate.detail ? (
                    <span className="muted gate-list__detail">{gate.detail}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {repairs.length > 0 ? (
          <div className="stack" aria-label="repair loop">
            <span className="label">repair loop</span>
            {repairs.map((repair) => (
              <div
                key={repair.ticketId}
                className={`banner ${repair.status === 'exhausted' ? 'banner--error' : 'banner--info'}`}
                data-testid="repair-row"
              >
                <span className="banner__body">
                  <span className="badge mono">{repair.ticketId}</span> {repair.attempts} repair
                  attempt(s) — {repair.status}
                  {repair.gate ? ` (gate ${repair.gate})` : ''}
                  {repair.reason ? `: ${repair.reason}` : ''}
                </span>
              </div>
            ))}
          </div>
        ) : null}

        {decided.length > 0 ? (
          <div className="stack">
            <span className="label">decided</span>
            {decided.map((review) => (
              <div
                key={review.sequence}
                className={`banner ${review.status === 'approved' ? 'banner--info' : 'banner--warn'}`}
              >
                <span className="banner__body">
                  {review.riskTier} risk — {review.status}
                  {review.rationale ? `: ${review.rationale}` : ''}
                </span>
              </div>
            ))}
          </div>
        ) : null}

        <ArtifactConfidence artifacts={artifacts} reducedTrust={reducedTrust} />
      </div>
    </section>
  );
}
