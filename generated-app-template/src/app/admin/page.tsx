'use client';

import { useEffect, useState } from 'react';
import { HealthBadge } from '@/components/HealthBadge';
import { StatusTimeline } from '@/components/StatusTimeline';
import { getStatus, listRequests } from '@/lib/api-client';
import type { HealthDTO, ServiceRequestDTO, StatusEventDTO } from '@/lib/types';

export default function AdminPage() {
  const [health, setHealth] = useState<HealthDTO | null>(null);
  const [events, setEvents] = useState<StatusEventDTO[]>([]);
  const [requests, setRequests] = useState<ServiceRequestDTO[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load(): Promise<void> {
      try {
        const [status, requestData] = await Promise.all([getStatus(), listRequests()]);
        setHealth(status.health);
        setEvents(status.events);
        setRequests(requestData.requests);
        setError(null);
      } catch (caught) {
        setError((caught as Error).message);
      }
    }
    void load();
  }, []);

  return (
    <section>
      <h1>Admin</h1>
      <p className="lede">Operational view: platform health, recent requests, and activity.</p>

      <HealthBadge health={health} />

      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}

      <h2>Recent requests</h2>
      {requests.length === 0 ? (
        <p className="empty">No requests yet.</p>
      ) : (
        <table className="table" data-testid="admin-requests">
          <thead>
            <tr>
              <th>Title</th>
              <th>Status</th>
              <th>Proposals</th>
              <th>Brief</th>
            </tr>
          </thead>
          <tbody>
            {requests.map((request) => (
              <tr key={request.id} data-testid="admin-request">
                <td>{request.title}</td>
                <td>
                  <span className={`badge badge-${request.status.toLowerCase()}`}>
                    {request.status}
                  </span>
                </td>
                <td>{request.proposals.length}</td>
                <td>{request.brief ? request.brief.source : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Recent activity</h2>
      {events.length === 0 ? (
        <p className="empty">No activity yet.</p>
      ) : (
        <StatusTimeline events={events} />
      )}
    </section>
  );
}
