/**
 * /api/requests
 *   GET  — list all service requests (newest first) with brief, proposals,
 *          status events, and customer.
 *   POST — create a request; generates the AI brief and the opening status
 *          events, then returns the created request.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import type { CreateRequestInput } from '@/lib/repository';
import { listServiceRequests, submitServiceRequest } from '@/lib/repository';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

function parseCreateRequest(body: unknown): { value: CreateRequestInput } | { error: string } {
  if (typeof body !== 'object' || body === null) {
    return { error: 'Request body must be a JSON object.' };
  }
  const b = body as Record<string, unknown>;
  const customerName = str(b.customerName);
  const customerEmail = str(b.customerEmail);
  const title = str(b.title);
  const description = str(b.description);
  const category = str(b.category);
  const budget = num(b.budget);
  if (!customerName || !customerEmail || !title || !description || !category || budget === undefined) {
    return {
      error:
        'customerName, customerEmail, title, description, category and budget are all required.',
    };
  }
  return { value: { customerName, customerEmail, title, description, category, budget } };
}

export async function GET(): Promise<NextResponse> {
  const requests = await listServiceRequests();
  return NextResponse.json({ requests });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'bad_request', message: 'Invalid JSON body.' }, { status: 400 });
  }
  const parsed = parseCreateRequest(body);
  if ('error' in parsed) {
    return NextResponse.json({ error: 'bad_request', message: parsed.error }, { status: 400 });
  }
  const created = await submitServiceRequest(parsed.value);
  return NextResponse.json({ request: created }, { status: 201 });
}
