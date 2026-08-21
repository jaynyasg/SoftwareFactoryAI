import type { HealthDTO } from '@/lib/types';

export function HealthBadge({ health }: { health: HealthDTO | null }) {
  if (!health) {
    return (
      <p className="muted" data-testid="health-status">
        Checking health…
      </p>
    );
  }
  const ok = health.status === 'ok';
  return (
    <div className="health" data-testid="health-status">
      <span className={`badge ${ok ? 'badge-accepted' : 'badge-degraded'}`}>
        {health.status.toUpperCase()}
      </span>
      <span className="muted">
        DB {health.database ? 'connected' : 'unavailable'} · {health.requestCount} requests ·{' '}
        {health.proposalCount} proposals
      </span>
    </div>
  );
}
