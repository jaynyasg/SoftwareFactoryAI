/**
 * Nested-agent metadata.
 *
 * When the agent family that invoked the factory equals the family of the
 * selected worker adapter, the run is a NESTED agent execution and the runner
 * records that metadata as event evidence on `worker.started`/`worker.completed`
 * (and on the returned result). When the families differ — or no caller family
 * is known — no nested metadata is recorded.
 */
import { describe, expect, it } from 'vitest';
import { createInMemoryEventStore } from '@software-factory/core';
import type { AdapterFamily, ExecutionAdapter, FactoryEvent } from '@software-factory/core';
import { NESTED_AGENT_EVIDENCE_LABEL, runTicket } from '../../src/index';
import { makeCompileInput } from '../_helpers/nodes';

function immediateAdapter(family: AdapterFamily): ExecutionAdapter {
  return {
    id: `imm-${family}`,
    family,
    detectSetup: () => Promise.resolve({ available: true, authenticated: true, capacity: 1 }),
    execute: (_task, opts) => {
      opts.onEvent({ kind: 'progress', message: 'working' });
      return Promise.resolve({ ok: true, output: 'done', artifacts: [] });
    },
    reportCapacity: () => 1,
  };
}

function hasNestedEvidence(event: FactoryEvent): boolean {
  return (event.evidence ?? []).some((item) => item.label === NESTED_AGENT_EVIDENCE_LABEL);
}

async function run(callerFamily: AdapterFamily | undefined, adapterFamily: AdapterFamily) {
  const store = createInMemoryEventStore();
  const controller = new AbortController();
  const result = await runTicket(
    {
      runId: 'run-nested',
      compileInput: makeCompileInput('tkt-1'),
      workspaceDir: '/tmp/ws',
      signal: controller.signal,
      callerFamily,
    },
    { store, adapter: immediateAdapter(adapterFamily) },
  );
  const events = await store.readRun('run-nested');
  return { result, events };
}

describe('nested-agent metadata', () => {
  it('records nested metadata when caller family == selected adapter family', async () => {
    const { result, events } = await run('claude', 'claude');

    expect(result.outcome).toBe('completed');
    expect(result.nested).toBe(true);

    const started = events.find((event) => event.type === 'worker.started');
    const completed = events.find((event) => event.type === 'worker.completed');
    expect(started).toBeDefined();
    expect(completed).toBeDefined();
    expect(hasNestedEvidence(started as FactoryEvent)).toBe(true);
    expect(hasNestedEvidence(completed as FactoryEvent)).toBe(true);

    const evidence = (started as FactoryEvent).evidence?.find(
      (item) => item.label === NESTED_AGENT_EVIDENCE_LABEL,
    );
    expect(evidence?.ref).toBe('claude');
    expect(evidence?.note).toContain('caller=claude');
  });

  it('does NOT record nested metadata when families differ', async () => {
    const { result, events } = await run('codex', 'claude');

    expect(result.outcome).toBe('completed');
    expect(result.nested).toBe(false);
    const started = events.find((event) => event.type === 'worker.started');
    expect(hasNestedEvidence(started as FactoryEvent)).toBe(false);
  });

  it('does NOT record nested metadata when no caller family is known', async () => {
    const { result, events } = await run(undefined, 'claude');

    expect(result.nested).toBe(false);
    const started = events.find((event) => event.type === 'worker.started');
    expect(hasNestedEvidence(started as FactoryEvent)).toBe(false);
  });
});
