/**
 * ArtifactDrawer — diffs, logs, files, and provenance for the selected ticket
 * (DESIGN.md §5). On desktop it sits inline in the run grid; on tablet/mobile it
 * becomes an overlay with a dismiss affordance (§9). Everything shown traces to
 * the ticket's ledger rows / artifacts — no invented content.
 */
import type { ArtifactView, LedgerRow } from '@software-factory/core';
import { Mono } from './primitives';
import { formatPercent } from '../../lib/run-view';

export function ArtifactDrawer({
  ticketId,
  artifacts,
  rows,
  overlay = false,
  onClose,
}: {
  readonly ticketId: string | null;
  readonly artifacts: readonly ArtifactView[];
  readonly rows: readonly LedgerRow[];
  readonly overlay?: boolean;
  readonly onClose?: () => void;
}) {
  const body =
    ticketId === null ? (
      <p className="muted">Select a ticket to inspect its artifacts, logs, and provenance.</p>
    ) : (
      <div className="drawer">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span className="label">ticket</span>
          <Mono value={ticketId} max={24} />
        </div>

        <div className="stack">
          <span className="label">artifacts &amp; provenance</span>
          {artifacts.length === 0 ? (
            <p className="muted">No artifacts recorded for this ticket.</p>
          ) : (
            artifacts.map((artifact) => (
              <div key={artifact.artifactId} className="worker-slot">
                <Mono value={artifact.path ?? artifact.artifactId} max={32} />
                <span className="muted" style={{ fontSize: 'var(--fs-2xs)' }}>
                  {artifact.kind ?? 'artifact'}
                  {artifact.confidence !== undefined
                    ? ` · confidence ${formatPercent(artifact.confidence)}`
                    : ''}
                </span>
              </div>
            ))
          )}
        </div>

        <div className="stack">
          <span className="label">logs &amp; evidence</span>
          {rows.length === 0 ? (
            <p className="muted">No ledger activity for this ticket yet.</p>
          ) : (
            <div className="drawer__diff" aria-label="ticket log">
              {rows
                .map((row) => {
                  const evidence = (row.evidence ?? [])
                    .map((e) => e.ref ?? e.href ?? e.digest ?? e.note ?? e.label)
                    .join(' ');
                  return `#${row.sequence} ${row.type}${row.detail ? ` — ${row.detail}` : ''}${
                    evidence ? ` [${evidence}]` : ''
                  }`;
                })
                .join('\n')}
            </div>
          )}
        </div>
      </div>
    );

  if (overlay) {
    return (
      <>
        <div className="drawer__scrim" onClick={onClose} aria-hidden="true" />
        <aside
          className="panel drawer--overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Artifact drawer"
        >
          <header className="panel__header">
            <h2 className="panel__title">Artifact drawer</h2>
            <button type="button" className="btn btn--sm btn--ghost" onClick={onClose}>
              Close
            </button>
          </header>
          <div className="panel__body">{body}</div>
        </aside>
      </>
    );
  }

  return (
    <section className="panel" aria-label="Artifact drawer">
      <header className="panel__header">
        <h2 className="panel__title">Artifact drawer</h2>
        {ticketId !== null && onClose ? (
          <button type="button" className="btn btn--sm btn--ghost" onClick={onClose}>
            Clear
          </button>
        ) : null}
      </header>
      <div className="panel__body">{body}</div>
    </section>
  );
}
