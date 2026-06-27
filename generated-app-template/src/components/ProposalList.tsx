'use client';

import type { ProposalDTO } from '@/lib/types';

type DecideHandler = (proposalId: string, action: 'accept' | 'reject') => void | Promise<void>;

export function ProposalList({
  proposals,
  onDecide,
}: {
  proposals: ProposalDTO[];
  onDecide?: DecideHandler;
}) {
  if (proposals.length === 0) {
    return <p className="muted">No proposals yet.</p>;
  }
  return (
    <ul className="proposals">
      {proposals.map((proposal) => (
        <li key={proposal.id} className="proposal" data-testid="proposal-card">
          <div className="proposal-head">
            <strong>{proposal.provider.name}</strong>
            <span className="price">{proposal.price}</span>
            <span
              className={`badge badge-${proposal.status.toLowerCase()}`}
              data-testid="proposal-status"
            >
              {proposal.status}
            </span>
          </div>
          <p className="muted">{proposal.message}</p>
          {onDecide && proposal.status === 'SUBMITTED' ? (
            <div className="actions">
              <button
                type="button"
                data-testid="proposal-accept"
                onClick={() => void onDecide(proposal.id, 'accept')}
              >
                Accept
              </button>
              <button
                type="button"
                className="secondary"
                data-testid="proposal-reject"
                onClick={() => void onDecide(proposal.id, 'reject')}
              >
                Reject
              </button>
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
