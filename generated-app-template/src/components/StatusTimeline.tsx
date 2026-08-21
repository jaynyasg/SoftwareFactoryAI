import type { StatusEventDTO } from '@/lib/types';

export function StatusTimeline({ events }: { events: StatusEventDTO[] }) {
  if (events.length === 0) {
    return null;
  }
  return (
    <ol className="timeline" data-testid="status-timeline">
      {events.map((event) => (
        <li key={event.id} className="timeline-item">
          <span className="dot" aria-hidden="true" />
          <span className="ev-type">{event.type}</span>
          <span className="muted">{event.message}</span>
        </li>
      ))}
    </ol>
  );
}
