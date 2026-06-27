/**
 * ReviewStudio — the risk-tiered review surface (DESIGN.md §5; Ash mapping).
 *
 * Brings together the risk tier, command-guarded decision cards, a trace
 * severity summary, artifact confidence, and provenance so a human can decide
 * whether to trust the work. Pending reviews render as DecisionCards (high risk
 * never auto-merges); decided reviews show their recorded outcome.
 */
import type { ArtifactView, OperatorSeverityCounts } from '@software-factory/core';
import type { ReviewItem } from '../../lib/run-view';
import type { ReviewMode } from '@software-factory/core';
import { DecisionCard } from './DecisionCard';
import { ArtifactConfidence } from './ArtifactConfidence';

export function ReviewStudio({
  runId,
  reviewMode,
  expectedVersion,
  reviews,
  artifacts,
  counts,
  reducedTrust = false,
  onReload,
}: {
  readonly runId: string;
  readonly reviewMode: ReviewMode;
  readonly expectedVersion: number;
  readonly reviews: readonly ReviewItem[];
  readonly artifacts: readonly ArtifactView[];
  readonly counts: OperatorSeverityCounts;
  readonly reducedTrust?: boolean;
  readonly onReload?: () => void;
}) {
  const pending = reviews.filter((review) => review.status === 'pending');
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
                summary={review.summary}
                evidence={review.evidence}
                onReload={onReload}
              />
            ))
          )}
        </div>

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
