/**
 * PackageHandoff — the packaged repo + handoff summary for a completed run
 * (U8; R26). Shows the package path, handoff/provenance references, packaging
 * commit, and artifact confidence once `package.created` exists on the ledger.
 * The panel makes the local-first contract visible: the package and provenance
 * are preserved even when the deploy stage pauses or fails (R30).
 */
import type { PackageView } from '../../lib/run-view';
import { formatPercent } from '../../lib/run-view';
import { Mono } from './primitives';

export function PackageHandoff({ pkg }: { readonly pkg: PackageView }) {
  const packaged = pkg.status === 'packaged';
  return (
    <section className="panel" aria-label="Package and handoff">
      <header className="panel__header">
        <h2 className="panel__title">Package &amp; handoff</h2>
        <span
          className={`badge sev-${packaged ? 'success' : 'info'}`}
          data-testid="package-status"
        >
          <span className="badge__dot" aria-hidden="true" />
          {packaged ? 'Packaged' : 'Not packaged'}
        </span>
      </header>
      <div className="panel__body">
        {!packaged ? (
          <p className="muted">
            The packaged repo, handoff, and provenance appear after all tickets and post-run gates
            pass.
          </p>
        ) : (
          <div className="stack">
            {pkg.repoPath ? (
              <div className="row">
                <span className="label">repo</span>
                <Mono value={pkg.repoPath} max={40} copyable />
              </div>
            ) : null}
            {pkg.commit ? (
              <div className="row">
                <span className="label">commit</span>
                <Mono value={pkg.commit} max={16} copyable />
              </div>
            ) : null}
            {pkg.handoffRef ? (
              <div className="row">
                <span className="label">handoff</span>
                <Mono value={pkg.handoffRef} max={28} />
              </div>
            ) : null}
            {pkg.provenanceRef ? (
              <div className="row">
                <span className="label">provenance</span>
                <Mono value={pkg.provenanceRef} max={28} />
              </div>
            ) : null}
            {pkg.confidence !== undefined ? (
              <div className="row">
                <span className="label">confidence</span>
                <span data-testid="package-confidence">{formatPercent(pkg.confidence)}</span>
              </div>
            ) : null}
            {pkg.summary ? <p className="muted">{pkg.summary}</p> : null}
            <p className="muted" style={{ fontSize: 'var(--fs-2xs)' }}>
              Local package and provenance are preserved even when the hosted deploy pauses or
              fails.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
