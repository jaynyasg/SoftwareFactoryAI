'use client';

import { useCallback, useEffect, useState } from 'react';
import { RequestForm } from '@/components/RequestForm';
import { RequestList } from '@/components/RequestList';
import { decideProposal, listRequests } from '@/lib/api-client';
import type { ServiceRequestDTO } from '@/lib/types';

export default function CustomerPage() {
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

  const handleDecide = useCallback(
    async (proposalId: string, action: 'accept' | 'reject') => {
      try {
        await decideProposal({ proposalId, action });
        await refresh();
      } catch (caught) {
        setError((caught as Error).message);
      }
    },
    [refresh],
  );

  return (
    <section>
      <h1>Customer</h1>
      <p className="lede">
        Submit a service request. We generate an AI brief instantly, then providers send proposals
        you can accept or reject.
      </p>

      <RequestForm onCreated={refresh} />

      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}

      <h2>Your requests</h2>
      {loading ? (
        <p className="muted">Loading…</p>
      ) : (
        <RequestList requests={requests} onDecide={handleDecide} showDecisions />
      )}
    </section>
  );
}
