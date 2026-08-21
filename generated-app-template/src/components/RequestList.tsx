'use client';

import type { ServiceRequestDTO } from '@/lib/types';
import { BriefCard } from './BriefCard';
import { ProposalList } from './ProposalList';
import { StatusTimeline } from './StatusTimeline';

type DecideHandler = (proposalId: string, action: 'accept' | 'reject') => void | Promise<void>;

export function RequestList({
  requests,
  onDecide,
  showDecisions = false,
}: {
  requests: ServiceRequestDTO[];
  onDecide?: DecideHandler;
  showDecisions?: boolean;
}) {
  if (requests.length === 0) {
    return <p className="empty">No requests yet.</p>;
  }
  return (
    <ul className="card-list">
      {requests.map((request) => (
        <li key={request.id} className="card" data-testid="request-card">
          <header className="card-head">
            <h3>{request.title}</h3>
            <span
              className={`badge badge-${request.status.toLowerCase()}`}
              data-testid="request-status"
            >
              {request.status}
            </span>
          </header>
          <p className="muted">
            {request.category} · budget {request.budget} · {request.customer.name}
          </p>
          <p>{request.description}</p>
          {request.brief ? <BriefCard brief={request.brief} /> : null}
          <h4 className="section-label">Proposals</h4>
          <ProposalList
            proposals={request.proposals}
            onDecide={showDecisions ? onDecide : undefined}
          />
          <h4 className="section-label">Status</h4>
          <StatusTimeline events={request.statusEvents} />
        </li>
      ))}
    </ul>
  );
}
