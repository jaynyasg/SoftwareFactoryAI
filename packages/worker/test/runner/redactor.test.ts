/**
 * U7 — per-run credential redaction at the worker append sites.
 *
 * Pins the rolling-buffer contract: a credential value never persists on the
 * ledger — not whole, and not reconstructibly when split across two stream
 * writes — while all other text passes through untouched.
 */
import { describe, expect, it } from 'vitest';
import { createInMemoryEventStore } from '@software-factory/core';
import type { AdapterResult, ExecutionAdapter } from '@software-factory/core';
import { REDACTED, createRollingRedactor, runTicket } from '../../src/index';
import { makeCompileInput } from '../_helpers/nodes';

const SECRET = 'sk-ant-verySecretCredential123';

describe('createRollingRedactor', () => {
  it('redacts whole occurrences and leaves other text untouched', () => {
    const redact = createRollingRedactor([SECRET, 'ghp_tokenXYZ']);
    expect(redact(`auth failed for ${SECRET} on retry`)).toBe(`auth failed for ${REDACTED} on retry`);
    expect(redact('plain progress message')).toBe('plain progress message');
    expect(redact(`two: ${SECRET} and ghp_tokenXYZ`)).toBe(`two: ${REDACTED} and ${REDACTED}`);
  });

  it('a secret SPLIT ACROSS TWO WRITES is not reconstructible from the output sequence', () => {
    const redact = createRollingRedactor([SECRET]);
    const first = redact(`prefix ${SECRET.slice(0, 12)}`);
    const second = redact(`${SECRET.slice(12)} suffix`);
    // The first chunk already flushed (half a token is not the credential);
    // the second chunk's spanning prefix MUST be cut so concatenating the
    // outputs never yields the full value.
    expect(`${first}${second}`).not.toContain(SECRET);
    expect(second).toContain(REDACTED);
    expect(second).toContain('suffix');
  });

  it('ignores empty/trivial secrets instead of redacting everything', () => {
    const redact = createRollingRedactor(['', '  ', 'ab']);
    expect(redact('nothing to hide ab-c')).toBe('nothing to hide ab-c');
  });

  it('state carries across many small writes (secret split into 4 chunks)', () => {
    const redact = createRollingRedactor([SECRET]);
    const parts = [SECRET.slice(0, 8), SECRET.slice(8, 16), SECRET.slice(16, 24), SECRET.slice(24)];
    const out = parts.map((part) => redact(part)).join('');
    expect(out).not.toContain(SECRET);
  });
});

describe('runTicket appends are scrubbed (deps.redact)', () => {
  const compileInput = () => makeCompileInput('tkt-1');

  function leakyAdapter(result: AdapterResult): ExecutionAdapter {
    return {
      id: 'leaky',
      family: 'claude',
      detectSetup: () => Promise.resolve({ available: true, authenticated: true, capacity: 1 }),
      execute: (_task, opts) => {
        // The CLI echoes its credential into a progress line (split across
        // two events) before finishing.
        opts.onEvent({ kind: 'progress', message: `env dump: ${SECRET.slice(0, 10)}` });
        opts.onEvent({ kind: 'progress', message: `${SECRET.slice(10)} (end)` });
        return Promise.resolve(result);
      },
      reportCapacity: () => 1,
    };
  }

  it('progress, summaries, and failure reasons never carry the credential — split included', async () => {
    const store = createInMemoryEventStore();
    const adapter = leakyAdapter({
      ok: false,
      error: {
        name: 'AdapterError',
        kind: 'auth_failed',
        message: `401 for bearer ${SECRET}`,
        retryable: false,
        waitable: false,
      } as never,
    });
    await runTicket(
      {
        runId: 'run-1',
        compileInput: compileInput(),
        workspaceDir: '/tmp/ws',
        signal: new AbortController().signal,
        maxAttempts: 1,
      },
      { store, adapter, redact: createRollingRedactor([SECRET]) },
    );

    const raw = JSON.stringify(await store.readRun('run-1'));
    expect(raw).not.toContain(SECRET);
    expect(raw).toContain(REDACTED);
    // Concatenation of ALL appended text still cannot reconstruct the value.
    const joined = (await store.readRun('run-1'))
      .map((event) => JSON.stringify(event.payload))
      .join('');
    expect(joined).not.toContain(SECRET);
  });

  it('without deps.redact the appended text is unchanged (single-tenant pin)', async () => {
    const store = createInMemoryEventStore();
    const adapter = leakyAdapter({ ok: true, output: 'done', artifacts: [] });
    await runTicket(
      {
        runId: 'run-1',
        compileInput: compileInput(),
        workspaceDir: '/tmp/ws',
        signal: new AbortController().signal,
        maxAttempts: 1,
      },
      { store, adapter },
    );
    const raw = JSON.stringify(await store.readRun('run-1'));
    expect(raw).toContain(SECRET.slice(0, 10));
  });
});
