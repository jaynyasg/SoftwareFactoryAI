'use client';

import { useCallback, useEffect, useState } from 'react';
import { BriefCard } from '@/components/BriefCard';
import { ProposalForm } from '@/components/ProposalForm';
import { listRequests } from '@/lib/api-client';
import type { ServiceRequestDTO } from '@/lib/types';

export default function ProviderPage() {
  const [requests, setRequests] = useState<ServiceRequestDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await listRequests();
      setRequests(data.requests);
      setError(null);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Providers can still propose while a request is OPEN or already PROPOSED.
  const openRequests = requests.filter(
    (request) => request.status === 'OPEN' || request.status === 'PROPOSED',
  );

  return (
    <section>
      <h1>Provider</h1>
      <p className="lede">Browse open requests and submit a proposal with your price.</p>

      <ProposalForm requests={openRequests} onSubmitted={refresh} />

      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}

      <h2>Open requests</h2>
      {loading ? (
        <p className="muted">Loading…</p>
      ) : openRequests.length === 0 ? (
        <p className="empty">No open requests right now.</p>
      ) : (
        <ul className="card-list">
          {openRequests.map((request) => (
            <li key={request.id} className="card" data-testid="open-request">
              <header className="card-head">
                <h3>{request.title}</h3>
                <span className={`badge badge-${request.status.toLowerCase()}`}>
                  {request.status}
                </span>
              </header>
              <p className="muted">
                {request.category} · budget {request.budget} · {request.proposals.length} proposals
              </p>
              <p>{request.description}</p>
              {request.brief ? <BriefCard brief={request.brief} /> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
