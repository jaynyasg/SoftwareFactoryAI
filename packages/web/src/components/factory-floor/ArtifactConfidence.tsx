/**
 * ArtifactConfidence — the blended confidence score WITH its breakdown
 * (gate pass rate, provenance completeness, dependency risk, preview evidence),
 * never a vanity number (DESIGN.md §5; approved direction; anti-slop §8). When a
 * sandbox fallback occurred the artifact is labeled reduced-trust everywhere.
 */
import type { ArtifactView } from '@software-factory/core';
import { Mono } from './primitives';
import { confidenceFactorRows, formatPercent } from '../../lib/run-view';

export function ArtifactConfidence({
  artifacts,
  reducedTrust = false,
}: {
  readonly artifacts: readonly ArtifactView[];
  readonly reducedTrust?: boolean;
}) {
  return (
    <section className="panel" aria-label="Artifact confidence">
      <header className="panel__header">
        <h2 className="panel__title">Artifact confidence</h2>
        <span className="panel__hint">blended from gate / provenance / risk / preview</span>
      </header>
      <div className="panel__body">
        {artifacts.length === 0 ? (
          <p className="muted">No artifacts produced yet.</p>
        ) : (
          artifacts.map((artifact) => {
            const factors = confidenceFactorRows(artifact.confidenceFactors);
            return (
              <div
                key={artifact.artifactId}
                className="ticket-card"
                aria-label={`Artifact ${artifact.artifactId}`}
              >
                <div className="ticket-card__head">
                  <span className="ticket-card__title">{artifact.kind ?? 'artifact'}</span>
                  {reducedTrust ? (
                    <span className="badge sev-warn" title="sandbox fallback was used">
                      reduced trust
                    </span>
                  ) : null}
                </div>
                {artifact.path ? <Mono value={artifact.path} max={36} /> : null}

                {artifact.confidence === undefined ? (
                  <p className="muted">Awaiting gate/preview evidence before scoring.</p>
                ) : (
                  <>
                    <div className="confidence__score">
                      <span className="confidence__score-value" data-testid="confidence-score">
                        {formatPercent(artifact.confidence)}
                      </span>
                      <span className="muted">blended confidence</span>
                    </div>
                    {factors.length === 0 ? (
                      <p className="muted" style={{ fontSize: 'var(--fs-2xs)' }}>
                        No factor breakdown recorded for this artifact.
                      </p>
                    ) : (
                      <div className="confidence__factors" aria-label="confidence factors">
                        {factors.map((factor) => (
                          <div key={factor.key} className="confidence__factor">
                            <span style={{ fontSize: 'var(--fs-xs)' }}>{factor.label}</span>
                            <span className="confidence__factor-value">
                              {formatPercent(factor.value)}
                            </span>
                            <span className="confidence__bar">
                              <span
                                className="confidence__bar-fill"
                                style={{ width: `${Math.round(factor.value * 100)}%` }}
                              />
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
