/**
 * /api/proposals
 *   GET   — list proposals, optionally filtered by ?requestId=.
 *   POST  — submit a proposal for a request (marks the request PROPOSED).
 *   PATCH — accept or reject a proposal (accepting closes the request and
 *           rejects the other open proposals).
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import type { CreateProposalInput, ProposalDecision } from '@/lib/repository';
import { decideProposal, listProposals, submitProposal } from '@/lib/repository';

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

function parseSubmit(body: unknown): { value: CreateProposalInput } | { error: string } {
  if (typeof body !== 'object' || body === null) {
    return { error: 'Request body must be a JSON object.' };
  }
  const b = body as Record<string, unknown>;
  const requestId = str(b.requestId);
  const providerName = str(b.providerName);
  const providerEmail = str(b.providerEmail);
  const message = str(b.message);
  const price = num(b.price);
  if (!requestId || !providerName || !providerEmail || !message || price === undefined) {
    return {
      error: 'requestId, providerName, providerEmail, message and price are all required.',
    };
  }
  return {
    value: { requestId, providerName, providerEmail, providerExpertise: str(b.providerExpertise), message, price },
  };
}

function parseDecision(
  body: unknown,
): { proposalId: string; action: ProposalDecision } | { error: string } {
  if (typeof body !== 'object' || body === null) {
    return { error: 'Request body must be a JSON object.' };
  }
  const b = body as Record<string, unknown>;
  const proposalId = str(b.proposalId);
  const action = b.action;
  if (!proposalId || (action !== 'accept' && action !== 'reject')) {
    return { error: 'proposalId and action ("accept" | "reject") are required.' };
  }
  return { proposalId, action };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = request.nextUrl.searchParams.get('requestId') ?? undefined;
  const proposals = await listProposals(requestId);
  return NextResponse.json({ proposals });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'bad_request', message: 'Invalid JSON body.' }, { status: 400 });
  }
  const parsed = parseSubmit(body);
  if ('error' in parsed) {
    return NextResponse.json({ error: 'bad_request', message: parsed.error }, { status: 400 });
  }
  try {
    const proposal = await submitProposal(parsed.value);
    return NextResponse.json({ proposal }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: 'unprocessable', message: (error as Error).message },
      { status: 422 },
    );
  }
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'bad_request', message: 'Invalid JSON body.' }, { status: 400 });
  }
  const parsed = parseDecision(body);
  if ('error' in parsed) {
    return NextResponse.json({ error: 'bad_request', message: parsed.error }, { status: 400 });
  }
  try {
    const proposal = await decideProposal(parsed.proposalId, parsed.action);
    return NextResponse.json({ proposal });
  } catch (error) {
    return NextResponse.json(
      { error: 'not_found', message: (error as Error).message },
      { status: 404 },
    );
  }
}
