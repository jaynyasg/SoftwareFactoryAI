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
import { readCookie, sessionCookieName } from '../../../../server/app';
import { getAuthService } from '../../../../server/instance';
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

  // Multi-user (U9): an expired/anonymous poll answers an HONEST 401 (the
  // client redirects to /login) — never a masking 404. Valid callers forward
  // their credentials so the poll sees the SAME owner-scoped view as the API.
  const callerHeaders = {
    cookie: req.headers.get('cookie') ?? undefined,
    authorization: req.headers.get('authorization') ?? undefined,
  };
  const authService = getAuthService();
  if (authService !== null) {
    const insecure =
      process.env.SF_INSECURE_COOKIES === '1' || process.env.SF_INSECURE_COOKIES === 'true';
    const sessionToken = readCookie(callerHeaders, sessionCookieName(insecure));
    const rawBearer = callerHeaders.authorization;
    const bearer = rawBearer?.toLowerCase().startsWith('bearer ')
      ? rawBearer.slice('bearer '.length).trim()
      : undefined;
    const identity =
      sessionToken !== undefined
        ? await authService.verifySession(sessionToken)
        : bearer !== undefined && bearer.startsWith('sfai_')
          ? await authService.verifyApiToken(bearer)
          : null;
    if (identity === null) {
      return NextResponse.json(
        { error: 'unauthenticated', message: 'Sign in to view this run.' },
        { status: 401 },
      );
    }
  }
  const aggregate = await loadRunAggregate(runId, after, callerHeaders);
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
