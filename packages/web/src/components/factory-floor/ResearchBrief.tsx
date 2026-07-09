/**
 * ResearchBrief — source-backed findings, sources, assumptions, and gaps from
 * the research projection (DESIGN.md §5, U9). Evidence is readable as dense
 * structured rows — never raw JSON. Nothing is invented: a run without
 * research events renders an honest "not requested" state, and a failed pass
 * still shows its partial findings and unresolved gaps (§6 partial state).
 */
import type { ResearchProjection } from '@software-factory/core';
import { Mono, SeverityBadge } from './primitives';
import { formatPercent } from '../../lib/run-view';

const CLASSIFICATION_LABEL: Readonly<Record<string, string>> = {
  verified_fact: 'verified fact',
  inference: 'inference',
};

export function ResearchBrief({
  research,
  compact = false,
}: {
  readonly research: ResearchProjection;
  /** Compact mode omits the panel frame (used inside the blueprint lane). */
  readonly compact?: boolean;
}) {
  const body = (
    <div className="stack research-brief" data-testid="research-brief">
      {research.status === 'none' ? (
        <p className="muted">
          No research was requested for this run — plan-only runs skip the research stage.
        </p>
      ) : null}

      {research.status === 'failed' && research.failureReason ? (
        <div className="banner banner--error" role="alert">
          <span className="banner__body">Research failed: {research.failureReason}</span>
        </div>
      ) : null}

      {research.briefSummary ? (
        <p style={{ fontSize: 'var(--fs-xs)' }} data-testid="research-summary">
          {research.briefSummary}
        </p>
      ) : null}

      {research.findings.length > 0 ? (
        <div className="stack" aria-label="research findings">
          <span className="label">findings</span>
          <ul className="evidence-list">
            {research.findings.map((finding) => (
              <li key={finding.findingId} className="research-row" data-testid="research-finding">
                <SeverityBadge
                  severity={finding.classification === 'verified_fact' ? 'success' : 'info'}
                  label={CLASSIFICATION_LABEL[finding.classification] ?? finding.classification}
                />
                <span className="research-row__body">
                  {finding.statement}
                  <span className="muted research-row__meta">
                    {finding.confidence !== undefined
                      ? ` · confidence ${formatPercent(finding.confidence)}`
                      : ''}
                    {finding.sourceIds.length > 0
                      ? ` · sources: ${finding.sourceIds.join(', ')}`
                      : ''}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {research.sources.length > 0 ? (
        <div className="stack" aria-label="research sources">
          <span className="label">
            sources · {research.readSourceCount}/{research.sourceCount} read
          </span>
          <ul className="evidence-list">
            {research.sources.map((source) => (
              <li key={source.sourceId} className="research-row" data-testid="research-source">
                <SeverityBadge
                  severity={source.read ? 'success' : 'info'}
                  label={source.read ? 'read' : 'found'}
                />
                <span className="research-row__body">
                  {source.title ?? source.sourceId}
                  {source.kind ? (
                    <span className="badge" style={{ marginLeft: 'var(--space-4)' }}>
                      {source.kind.replace(/_/g, ' ')}
                    </span>
                  ) : null}
                  {source.locator ? (
                    <span className="research-row__meta">
                      <Mono value={source.locator} max={44} />
                    </span>
                  ) : null}
                  {source.summary ? (
                    <span className="muted research-row__meta">{source.summary}</span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {research.assumptions.length > 0 ? (
        <div className="stack" aria-label="research assumptions">
          <span className="label">assumptions</span>
          <ul className="evidence-list">
            {research.assumptions.map((assumption) => (
              <li key={assumption.assumptionId} className="research-row">
                <SeverityBadge severity="warn" label="assumption" />
                <span className="research-row__body">
                  {assumption.statement}
                  {assumption.reason ? (
                    <span className="muted research-row__meta">{assumption.reason}</span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {research.gaps.length > 0 ? (
        <div className="stack" aria-label="research gaps">
          <span className="label">gaps</span>
          <ul className="evidence-list">
            {research.gaps.map((gap) => (
              <li key={gap.gapId} className="research-row" data-testid="research-gap">
                <SeverityBadge
                  severity={gap.resolved ? 'success' : gap.blocking ? 'error' : 'warn'}
                  label={gap.resolved ? 'resolved' : gap.blocking ? 'blocking gap' : 'open gap'}
                />
                <span className="research-row__body">
                  {gap.question}
                  {gap.impact ? (
                    <span className="muted research-row__meta">{gap.impact}</span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );

  if (compact) {
    return body;
  }
  return (
    <section className="panel" aria-label="Research brief">
      <header className="panel__header">
        <h2 className="panel__title">Research</h2>
        <SeverityBadge
          severity={
            research.status === 'completed'
              ? 'success'
              : research.status === 'failed'
                ? 'error'
                : 'info'
          }
          label={research.status.replace(/_/g, ' ')}
        />
      </header>
      <div className="panel__body">{body}</div>
    </section>
  );
}
