/**
 * Setup status route (read-only).
 *
 *   GET /api/setup — feeds the UI setup checklist.
 *
 * Reports whether a local operator token exists and returns conservative
 * placeholders for sandbox/adapter/deploy readiness. Real sandbox/adapter
 * detection lands in U5/U6 and deploy config in U9; until then these are
 * intentionally "unknown"/"required" so the checklist shows work remaining.
 */
import type { ApiResponse, RouteContext, RouteDef } from '../app';

async function getSetup(ctx: RouteContext): Promise<ApiResponse> {
  const session = await ctx.operatorToken.current();
  return {
    status: 200,
    body: {
      operatorToken: { present: session !== null },
      sandbox: { status: 'unknown' },
      adapters: { status: 'unknown', detected: [] as readonly string[] },
      deploy: { status: 'required' },
      workspace: { root: process.cwd() },
    },
  };
}

export function setupRoutes(): RouteDef[] {
  return [{ method: 'GET', pattern: '/api/setup', handler: getSetup }];
}
