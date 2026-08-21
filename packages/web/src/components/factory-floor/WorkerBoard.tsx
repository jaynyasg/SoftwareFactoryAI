/**
 * WorkerBoard — active/queued workers (each mapped to a ticket) up to the cap,
 * with the effective capacity and any throttle reasons. The cap is rendered as a
 * system-gated upper bound, never a promise (DESIGN.md §5; plan R4/R7).
 */
import type { TicketView } from '@software-factory/core';
import { Mono } from './primitives';
import { deriveWorkerBoard } from '../../lib/run-view';

export function WorkerBoard({
  tickets,
  requestedCap,
  adapterCapacity,
  throttleReasons = [],
}: {
  readonly tickets: readonly TicketView[];
  readonly requestedCap?: number;
  readonly adapterCapacity?: number;
  readonly throttleReasons?: readonly string[];
}) {
  const board = deriveWorkerBoard(tickets);
  const cap = requestedCap ?? 10;
  const effectiveCap = Math.min(cap, adapterCapacity ?? cap);
  const activeCount = board.active.length;
  const pips = Array.from({ length: cap }, (_, i) => {
    if (i < activeCount) {
      return 'active' as const;
    }
    if (i >= effectiveCap) {
      return 'gated' as const;
    }
    return 'idle' as const;
  });

  return (
    <section className="panel" aria-label="Worker board">
      <header className="panel__header">
        <h2 className="panel__title">Workers</h2>
        <span className="panel__hint">
          {activeCount} active · {board.queued.length} queued · {board.done.length} done
        </span>
      </header>
      <div className="panel__body">
        <div className="stack">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="label">
              capacity {effectiveCap} / {cap}
            </span>
            <span className="badge" title="The worker cap is an upper bound, not a guarantee.">
              cap is system-gated
            </span>
          </div>
          <div
            className="capacity-bar"
            role="img"
            aria-label={`${activeCount} active workers of an effective capacity of ${effectiveCap}, requested cap ${cap}`}
          >
            {pips.map((kind, i) => (
              <span key={i} className={`capacity-pip capacity-pip--${kind}`} />
            ))}
          </div>
          {effectiveCap < cap ? (
            <p className="sev-warn" style={{ fontSize: 'var(--fs-2xs)' }}>
              Throttled below requested cap by system constraints.
            </p>
          ) : null}
          {throttleReasons.length > 0 ? (
            <ul className="stack" style={{ listStyle: 'none', margin: 0, padding: 0, gap: 2 }}>
              {throttleReasons.map((reason, i) => (
                <li key={i} className="muted" style={{ fontSize: 'var(--fs-2xs)' }}>
                  · {reason}
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <div className="stack">
          <span className="label">active</span>
          {board.active.length === 0 ? (
            <p className="muted">No active workers.</p>
          ) : (
            <div className="worker-slots">
              {board.active.map((ticket) => (
                <div key={ticket.ticketId} className="worker-slot worker-slot--active">
                  <Mono value={ticket.ticketId} max={18} copyable={false} />
                  <span className="muted" style={{ fontSize: 'var(--fs-2xs)' }}>
                    {ticket.state}
                    {ticket.attempts > 0 ? ` · attempt ${ticket.attempts}` : ''}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {board.queued.length > 0 ? (
          <div className="stack">
            <span className="label">queued</span>
            <div className="worker-slots">
              {board.queued.map((ticket) => (
                <div key={ticket.ticketId} className="worker-slot">
                  <Mono value={ticket.ticketId} max={18} copyable={false} />
                  <span className="muted" style={{ fontSize: 'var(--fs-2xs)' }}>
                    waiting for capacity / dependencies
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
