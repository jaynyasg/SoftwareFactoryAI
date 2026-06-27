/**
 * SupervisorPanel — supervisor decisions with rationale + confidence, plus a
 * ticket DAG overview (each ticket and what it depends on). Confidence is shown
 * honestly as a percentage from the event payload, never inflated (DESIGN.md §5,
 * anti-slop §8).
 */
import type { RunProjection, TicketView } from '@software-factory/core';
import { Mono } from './primitives';
import { formatPercent } from '../../lib/run-view';

export function SupervisorPanel({
  decisions,
  tickets,
}: {
  readonly decisions: RunProjection['supervisorDecisions'];
  readonly tickets: readonly TicketView[];
}) {
  return (
    <section className="panel" aria-label="Supervisor">
      <header className="panel__header">
        <h2 className="panel__title">Supervisor</h2>
        <span className="panel__hint">{decisions.length} decisions</span>
      </header>
      <div className="panel__body">
        {decisions.length === 0 ? (
          <p className="muted">No supervisor decisions yet.</p>
        ) : (
          <ul className="stack" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {decisions.map((decision) => (
              <li key={decision.sequence} className="ticket-card">
                <div className="ticket-card__head">
                  <span className="ticket-card__title">{decision.decision}</span>
                  <span
                    className={`badge ${decision.confidence < 0.5 ? 'sev-warn' : 'sev-info'}`}
                    title="supervisor confidence"
                  >
                    confidence {formatPercent(decision.confidence)}
                  </span>
                </div>
                <p className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
                  {decision.rationale}
                </p>
              </li>
            ))}
          </ul>
        )}

        <div className="stack">
          <span className="label">Ticket DAG overview</span>
          {tickets.length === 0 ? (
            <p className="muted">No tickets planned yet.</p>
          ) : (
            <ul className="stack" style={{ listStyle: 'none', margin: 0, padding: 0, gap: 2 }}>
              {tickets.map((ticket) => (
                <li key={ticket.ticketId} className="row" style={{ gap: 'var(--space-8)' }}>
                  <Mono value={ticket.ticketId} max={18} copyable={false} />
                  {ticket.dependsOn.length > 0 ? (
                    <>
                      <span className="muted" aria-hidden="true">
                        ←
                      </span>
                      <span className="muted" style={{ fontSize: 'var(--fs-2xs)' }}>
                        {ticket.dependsOn.join(', ')}
                      </span>
                    </>
                  ) : (
                    <span className="muted" style={{ fontSize: 'var(--fs-2xs)' }}>
                      root
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
