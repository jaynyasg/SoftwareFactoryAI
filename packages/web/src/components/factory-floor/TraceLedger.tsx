/**
 * TraceLedger — the append-only event spine (DESIGN.md §5; approved direction).
 *
 * Rows carry severity color AND the event type label (never color alone). New
 * events are announced through a polite live-region (role="log") so screen
 * readers hear them without being interrupted (§7). The client resumes the
 * stream from `last_sequence`; while a poll is failing it shows a reconnecting
 * banner instead of pretending the stream is live (§6). Projection gaps/corrupt
 * events surface as an explicit diagnostic banner rather than silent holes.
 */
import type { LedgerRow, ProjectionDiagnostic } from '@software-factory/core';
import { Mono } from './primitives';
import { formatTimestamp, severityClass } from '../../lib/run-view';

export function TraceLedger({
  rows,
  lastSequence,
  reconnecting = false,
  diagnostics = [],
}: {
  readonly rows: readonly LedgerRow[];
  readonly lastSequence: number;
  readonly reconnecting?: boolean;
  readonly diagnostics?: readonly ProjectionDiagnostic[];
}) {
  const gaps = diagnostics.filter(
    (d) =>
      d.code === 'sequence_gap' || d.code === 'duplicate_sequence' || d.code === 'corrupt_event',
  );

  return (
    <section className="panel" aria-label="Trace ledger">
      <header className="panel__header">
        <h2 className="panel__title">Trace ledger</h2>
        <span className="panel__hint mono">last_sequence {lastSequence}</span>
      </header>
      <div className="panel__body">
        {reconnecting ? (
          <div className="banner banner--warn" role="status" data-testid="ledger-reconnecting">
            <span aria-hidden="true">↻</span>
            <span className="banner__body">
              Reconnecting — resuming the stream from sequence {lastSequence}.
            </span>
          </div>
        ) : null}

        {gaps.length > 0 ? (
          <div className="banner banner--warn" role="alert" data-testid="ledger-gap">
            <span className="banner__body">
              Projection gap: {gaps.map((g) => g.message).join(' ')}
            </span>
          </div>
        ) : null}

        {rows.length === 0 ? (
          <p className="muted">No events yet.</p>
        ) : (
          <div
            className="ledger"
            role="log"
            aria-live="polite"
            aria-relevant="additions"
            aria-label="Run event stream"
          >
            {rows.map((row) => (
              <div className="ledger__row" key={`${row.sequence}:${row.eventId}`}>
                <span className="ledger__seq">#{row.sequence}</span>
                <span
                  className={`ledger__sev ${severityClass(row.severity)}`}
                  role="img"
                  aria-label={`severity ${row.severity}`}
                />
                <span className="ledger__type">
                  {row.type}
                  {row.detail ? <span className="ledger__detail">{row.detail}</span> : null}
                  {row.ticketId ? (
                    <span className="ledger__detail">
                      ticket <Mono value={row.ticketId} max={16} copyable={false} />
                    </span>
                  ) : null}
                </span>
                <span className="ledger__time">{formatTimestamp(row.timestamp)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
