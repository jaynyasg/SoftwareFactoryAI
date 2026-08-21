/**
 * /api/status
 *   GET — health check plus the status-event timeline. Optionally filter the
 *         timeline by ?requestId=. Health reports DB reachability and a couple
 *         of counts so the admin dashboard can show real state.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getPrisma } from '@/lib/repository';
import { listStatusEvents } from '@/lib/status-events';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = request.nextUrl.searchParams.get('requestId') ?? undefined;
  const timestamp = new Date().toISOString();
  try {
    const db = getPrisma();
    const [events, requestCount, proposalCount] = await Promise.all([
      listStatusEvents(requestId),
      db.serviceRequest.count(),
      db.proposal.count(),
    ]);
    return NextResponse.json({
      health: { status: 'ok', database: true, requestCount, proposalCount, timestamp },
      events,
    });
  } catch (error) {
    return NextResponse.json({
      health: { status: 'degraded', database: false, requestCount: 0, proposalCount: 0, timestamp },
      events: [],
      error: (error as Error).message,
    });
  }
}
