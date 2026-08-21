/**
 * Remote MCP endpoint for web-hosted model clients (Claude.com custom
 * connectors, ChatGPT.com remote-MCP integrations, and other hosted callers).
 *
 * Use this URL as the connector target:
 *   https://<factory-host>/mcp
 *
 * Tool calls authenticate with the CALLER's own credential (U4 pass-through):
 * a personal API token on multi-user factories, or the operator token on
 * single-tenant ones — `Authorization: Bearer <token>` or `x-operator-token`.
 * The bridge forwards the header verbatim; the route layer is the only
 * verifier. Platforms that can only speak OAuth should sit behind an auth
 * proxy that injects the header — see docs/runbooks/cloud-deployment.md.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getApp } from '../../server/instance';
import { handleMcpRequest } from '../../server/mcp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function headersOf(req: NextRequest): Record<string, string | undefined> {
  const headers: Record<string, string | undefined> = {};
  req.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return headers;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = undefined;
  }
  const response = await handleMcpRequest({ body, headers: headersOf(req) }, { app: getApp() });
  return NextResponse.json(response.body ?? null, {
    status: response.status,
    headers: response.headers,
  });
}

export function GET(): NextResponse {
  return NextResponse.json({
    name: 'software-factory',
    transport: 'streamable-http',
    message: 'POST JSON-RPC MCP requests to this endpoint.',
    authentication:
      'Tool calls require YOUR credential: a personal API token (multi-user factories — ' +
      'mint one under Settings) or the operator token (single-tenant), sent as ' +
      '`Authorization: Bearer <token>` or `x-operator-token`. OAuth-only platforms need ' +
      'an auth proxy in front of this endpoint (see docs/runbooks/cloud-deployment.md).',
    documentation: [
      'integrations/claude/remote-mcp.md',
      'integrations/chatgpt/remote-mcp.md',
      'docs/runbooks/cloud-deployment.md',
    ],
  });
}
