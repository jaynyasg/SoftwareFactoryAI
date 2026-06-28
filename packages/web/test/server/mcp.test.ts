import { describe, expect, it } from 'vitest';
import {
  createInMemoryEventStore,
  createInMemoryOperatorTokenStore,
  createOperatorTokenProvider,
  type EventStore,
} from '@software-factory/core';
import { createApp, type App } from '../../src/server/app';
import { handleMcpRequest } from '../../src/server/mcp';
import type { LocalSession } from '../../src/lib/session';

const TOKEN = 'mcp-operator-token';
const CSRF = 'mcp-csrf-token';

function makeMcp(): { app: App; store: EventStore; session: LocalSession } {
  const store = createInMemoryEventStore();
  const provider = createOperatorTokenProvider({
    store: createInMemoryOperatorTokenStore({ token: TOKEN, createdAt: 0 }),
  });
  let runSeq = 0;
  const app = createApp({
    store,
    operatorToken: provider,
    idGenerator: () => `mcp-run-${(runSeq += 1)}`,
    config: { allowedOrigins: [], csrfToken: CSRF },
  });
  return { app, store, session: { operatorToken: TOKEN, csrfToken: CSRF } };
}

describe('remote MCP bridge', () => {
  it('lists Software Factory tools without requiring auth', async () => {
    const { app, session } = makeMcp();
    const res = await handleMcpRequest(
      { body: { jsonrpc: '2.0', id: 1, method: 'tools/list' }, headers: {} },
      { app, getSession: () => Promise.resolve(session) },
    );

    expect(res.status).toBe(200);
    const body = res.body as { result: { tools: { name: string }[] } };
    expect(body.result.tools.map((tool) => tool.name)).toContain('software_factory_create_run');
    expect(body.result.tools.map((tool) => tool.name)).toContain('software_factory_get_events');
  });

  it('creates a planned run through tools/call with a bearer operator token', async () => {
    const { app, session, store } = makeMcp();
    const res = await handleMcpRequest(
      {
        body: {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'software_factory_create_run',
            arguments: {
              prompt: 'Build an AI services marketplace with providers and proposals',
              requestedWorkerCap: 10,
            },
          },
        },
        headers: { authorization: `Bearer ${TOKEN}` },
      },
      { app, getSession: () => Promise.resolve(session) },
    );

    expect(res.status).toBe(200);
    const rpc = res.body as { result: { isError?: boolean; content: { text: string }[] } };
    expect(rpc.result.isError).toBe(false);
    const toolBody = JSON.parse(rpc.result.content[0].text) as {
      runId: string;
      run: { status: string };
    };
    expect(toolBody.runId).toBe('mcp-run-1');
    expect(toolBody.run.status).toBe('planned');
    expect((await store.readRun('mcp-run-1')).map((event) => event.type)).toContain('run.planned');
  });

  it('rejects tools/call with an invalid token before creating a run', async () => {
    const { app, session, store } = makeMcp();
    const res = await handleMcpRequest(
      {
        body: {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'software_factory_create_run', arguments: { prompt: 'x' } },
        },
        headers: { authorization: 'Bearer wrong' },
      },
      { app, getSession: () => Promise.resolve(session) },
    );

    const rpc = res.body as { result: { isError?: boolean; content: { text: string }[] } };
    expect(rpc.result.isError).toBe(true);
    expect(rpc.result.content[0].text).toContain('Operator token is invalid');
    expect(await store.listRuns()).toEqual([]);
  });
});
