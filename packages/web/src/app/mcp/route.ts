/**
 * Remote MCP endpoint for web-hosted model clients.
 *
 * Use this URL as the Claude.com custom connector target:
 *   https://<factory-host>/mcp
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getApp, getLocalSession } from '../../server/instance';
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
  const response = await handleMcpRequest(
    { body, headers: headersOf(req) },
    { app: getApp(), getSession: getLocalSession },
  );
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
  });
}
