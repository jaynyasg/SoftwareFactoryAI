/**
 * TicketCard — ticket state, risk tier, dependencies, assigned module/worker,
 * and a gate/failure summary, all projected from events (DESIGN.md §5).
 */
import type { TicketView } from '@software-factory/core';
import { Mono, RiskBadge, StateBadge } from './primitives';

export function TicketCard({
  ticket,
  reducedTrust = false,
  onOpen,
}: {
  readonly ticket: TicketView;
  readonly reducedTrust?: boolean;
  readonly onOpen?: (ticketId: string) => void;
}) {
  return (
    <article className="ticket-card" aria-label={`Ticket ${ticket.ticketId}`}>
      <div className="ticket-card__head">
        <span className="ticket-card__title">{ticket.title ?? ticket.ticketId}</span>
        <StateBadge state={ticket.state} />
      </div>

      <div className="ticket-card__meta">
        <Mono value={ticket.ticketId} max={22} />
        {ticket.riskTier ? <RiskBadge tier={ticket.riskTier} /> : null}
        {ticket.moduleId ? (
          <span className="badge" title="genome module">
            <span className="label" style={{ letterSpacing: 0 }}>
              module
            </span>
            <Mono value={ticket.moduleId} max={18} copyable={false} />
          </span>
        ) : null}
        {ticket.attempts > 0 ? (
          <span className="badge sev-warn" title="retry attempts">
            attempt {ticket.attempts}
          </span>
        ) : null}
        {reducedTrust ? (
          <span className="badge sev-warn" title="sandbox fallback was used">
            reduced trust
          </span>
        ) : null}
      </div>

      {ticket.dependsOn.length > 0 ? (
        <div className="row" aria-label="dependencies">
          <span className="label">depends on</span>
          {ticket.dependsOn.map((dep) => (
            <Mono key={dep} value={dep} max={16} copyable={false} />
          ))}
        </div>
      ) : (
        <span className="muted" style={{ fontSize: 'var(--fs-2xs)' }}>
          no dependencies
        </span>
      )}

      {ticket.failureReason ? (
        <p className="sev-error" style={{ fontSize: 'var(--fs-xs)' }}>
          {ticket.failureReason}
        </p>
      ) : null}

      {onOpen ? (
        <div className="row">
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={() => onOpen(ticket.ticketId)}
          >
            Open artifacts
          </button>
        </div>
      ) : null}
    </article>
  );
}
