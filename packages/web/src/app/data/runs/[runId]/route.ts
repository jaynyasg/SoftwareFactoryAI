/**
 * Read-only UI data route: the live projected view of one run.
 *
 * This is NOT part of the U3 command API and never mutates anything — it is a
 * pure projection read the client polls (with an optional `?after=<sequence>`
 * cursor so the trace ledger resumes from `last_sequence` instead of refetching
 * the whole log). It lives under `/data/...`, deliberately outside `/api/...`,
 * so it does not collide with the U3 catch-all. All projection work runs
 * server-side via core's projection functions (see server/run-data.ts).
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { loadRunAggregate } from '../../../../server/run-data';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ runId: string }> },
): Promise<NextResponse> {
  const { runId } = await ctx.params;
  const afterRaw = req.nextUrl.searchParams.get('after');
  const after = afterRaw !== null && Number.isFinite(Number(afterRaw)) ? Number(afterRaw) : 0;

  const aggregate = await loadRunAggregate(runId, after);
  if (aggregate === null) {
    return NextResponse.json(
      { error: 'not_found', message: `Run ${runId} does not exist.` },
      { status: 404 },
    );
  }
  return NextResponse.json(aggregate, {
    status: 200,
    headers: { 'cache-control': 'no-store' },
  });
}
