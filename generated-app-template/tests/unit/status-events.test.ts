import { describe, expect, it } from 'vitest';
import { appendStatusEvent, listStatusEvents } from '@/lib/status-events';
import { submitServiceRequest } from '@/lib/repository';

function baseRequest(email: string, title: string) {
  return {
    customerName: 'Customer',
    customerEmail: email,
    title,
    description: 'A description long enough to matter.',
    category: 'General',
    budget: 1000,
  };
}

describe('status-events', () => {
  it('appends and reads events for a request in insertion order', async () => {
    const request = await submitServiceRequest(baseRequest('se1@test.local', 'Timeline'));
    await appendStatusEvent({
      requestId: request.id,
      type: 'PROPOSAL_SUBMITTED',
      message: 'A proposal arrived',
    });

    const events = await listStatusEvents(request.id);
    // submitServiceRequest already wrote REQUEST_CREATED + BRIEF_GENERATED.
    expect(events.map((event) => event.type)).toEqual([
      'REQUEST_CREATED',
      'BRIEF_GENERATED',
      'PROPOSAL_SUBMITTED',
    ]);
  });

  it('scopes events by requestId', async () => {
    const a = await submitServiceRequest(baseRequest('se2a@test.local', 'A'));
    const b = await submitServiceRequest(baseRequest('se2b@test.local', 'B'));

    const eventsA = await listStatusEvents(a.id);
    const eventsB = await listStatusEvents(b.id);

    expect(eventsA.length).toBeGreaterThan(0);
    expect(eventsA.every((event) => event.requestId === a.id)).toBe(true);
    expect(eventsB.every((event) => event.requestId === b.id)).toBe(true);
  });

  it('returns every event when no requestId filter is given', async () => {
    await submitServiceRequest(baseRequest('se3a@test.local', 'A'));
    await submitServiceRequest(baseRequest('se3b@test.local', 'B'));
    const all = await listStatusEvents();
    // Two requests, two opening events each.
    expect(all.length).toBe(4);
  });
});
