import type { BriefDTO } from '@/lib/types';

export function BriefCard({ brief }: { brief: BriefDTO }) {
  return (
    <div className="brief" data-testid="brief-card">
      <div className="brief-head">
        <h4>AI Brief</h4>
        <span className="tag" data-testid="brief-source">
          {brief.source}
        </span>
      </div>
      <p>{brief.summary}</p>
      <details>
        <summary>Scope &amp; success criteria</summary>
        <p className="brief-label">Scope</p>
        <pre className="brief-block">{brief.scope}</pre>
        <p className="brief-label">Success criteria</p>
        <pre className="brief-block">{brief.successCriteria}</pre>
      </details>
      <p className="muted">Suggested budget: {brief.suggestedBudget}</p>
    </div>
  );
}
