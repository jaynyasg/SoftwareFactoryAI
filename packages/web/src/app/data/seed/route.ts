/**
 * Dev-only seed route (disabled in production builds).
 *
 * The U8 UI renders an active run purely from ledger events, but the U4–U7
 * runtime that emits them is not wired into the web dev server. To exercise a
 * rich run in e2e, this route appends a provided event log THROUGH the singleton
 * store in-process — so the store's cache reflects it immediately (writing the
 * JSONL file directly would be missed once the store has hydrated all runs).
 * Sequences are reassigned by the store in append order; callers send fully-
 * formed events and the version/sequence fields are ignored.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import type { AppendableEvent } from '@software-factory/core';
import { getStore } from '../../../server/instance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A cross-origin browser page must not be able to poison the local ledger. Allow
 * only same-origin/no-Origin requests (the e2e) and loopback dev origins; reject
 * any other present `Origin`.
 */
function isAllowedSeedOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

function toAppendable(raw: unknown): AppendableEvent | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const r = raw as Record<string, unknown>;
  if (
    typeof r.runId !== 'string' ||
    typeof r.type !== 'string' ||
    typeof r.actor !== 'object' ||
    r.actor === null ||
    typeof r.subject !== 'object' ||
    r.subject === null ||
    typeof r.payload !== 'object' ||
    r.payload === null
  ) {
    return null;
  }
  // The seeded payload is intentionally dynamic (arbitrary event families); the
  // store validates the envelope on append. Build the appendable shape, dropping
  // store-assigned fields (version/sequence).
  return {
    runId: r.runId,
    type: r.type,
    actor: r.actor,
    subject: r.subject,
    severity: r.severity,
    payload: r.payload,
    ticketId: typeof r.ticketId === 'string' ? r.ticketId : undefined,
    evidence: Array.isArray(r.evidence) ? r.evidence : undefined,
    eventId: typeof r.eventId === 'string' ? r.eventId : undefined,
    timestamp: typeof r.timestamp === 'number' ? r.timestamp : undefined,
    idempotencyKey: typeof r.idempotencyKey === 'string' ? r.idempotencyKey : undefined,
  } as AppendableEvent;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'seed_disabled' }, { status: 404 });
  }
  const origin = req.headers.get('origin');
  if (origin !== null && origin.length > 0 && !isAllowedSeedOrigin(origin)) {
    return NextResponse.json({ error: 'forbidden_origin' }, { status: 403 });
  }
  const body = (await req.json().catch(() => null)) as { events?: unknown[] } | null;
  if (body === null || !Array.isArray(body.events)) {
    return NextResponse.json(
      { error: 'bad_request', message: 'events[] required' },
      { status: 400 },
    );
  }

  const store = getStore();
  let count = 0;
  for (const raw of body.events) {
    const appendable = toAppendable(raw);
    if (appendable !== null) {
      await store.append(appendable);
      count += 1;
    }
  }
  return NextResponse.json({ ok: true, count });
}
