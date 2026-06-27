/**
 * Catch-all Route Handler that mounts the ENTIRE U3 local API under Next.
 *
 * It only adapts transport: NextRequest -> ApiRequest, call the singleton app's
 * `handle()`, ApiResponse -> NextResponse. All routing, the command guard, and
 * every side effect live in the framework-agnostic app (packages/web/src/server)
 * — there is no duplicated route logic here. Mutating routes still require
 * x-operator-token + x-csrf-token + an allowed Origin exactly as the unit tests
 * and operator-access e2e exercise them.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getApp } from '../../../server/instance';
import type { ApiRequest } from '../../../server/app';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ParseResult {
  readonly request?: ApiRequest;
  readonly invalidJson?: true;
}

async function toApiRequest(req: NextRequest): Promise<ParseResult> {
  const url = new URL(req.url);
  const query: Record<string, string | undefined> = {};
  url.searchParams.forEach((value, key) => {
    query[key] = value;
  });
  const headers: Record<string, string | undefined> = {};
  req.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  let body: unknown;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const raw = (await req.text()).trim();
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw);
      } catch {
        return { invalidJson: true };
      }
    }
  }
  return { request: { method: req.method, path: url.pathname, query, headers, body } };
}

async function handle(req: NextRequest): Promise<NextResponse> {
  const parsed = await toApiRequest(req);
  if (parsed.invalidJson === true || parsed.request === undefined) {
    return NextResponse.json(
      { error: 'invalid_json', message: 'Request body is not valid JSON.' },
      { status: 400 },
    );
  }
  const res = await getApp().handle(parsed.request);
  return NextResponse.json(res.body ?? null, { status: res.status, headers: res.headers });
}

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const DELETE = handle;
