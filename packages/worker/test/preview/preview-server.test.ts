/**
 * Preview-server unit behavior (deterministic — injected health check + sleep,
 * fake long-running runner; no network, no real timers).
 *
 * Asserts the core U6 guarantee: the preview URL is exposed ONLY after local
 * health succeeds (no `preview.ready`/url before then), the failure path emits
 * `preview.failed` with no url, and an early process exit fails the preview.
 */
import { describe, expect, it } from 'vitest';
import { createInMemoryEventStore } from '@software-factory/core';
import type { CommandRunner } from '@software-factory/core';
import { startPreview } from '../../src/index';

function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError' });
}

/** A runner whose process stays up until the abort signal fires (a real server). */
function serverRunner(): CommandRunner {
  return {
    run: (_command, _args, options) =>
      new Promise((_resolve, reject) => {
        if (options?.signal?.aborted) {
          reject(abortError());
          return;
        }
        options?.signal?.addEventListener('abort', () => reject(abortError()), { once: true });
      }),
  };
}

const noSleep = (): Promise<void> => Promise.resolve();

describe('startPreview', () => {
  it('exposes the URL only after health passes and emits the event sequence', async () => {
    const store = createInMemoryEventStore();
    const url = 'http://127.0.0.1:5555';
    const probes: boolean[] = [];
    let calls = 0;

    const result = await startPreview(
      {
        runId: 'run-preview',
        command: 'pnpm',
        args: ['preview'],
        url,
        maxHealthAttempts: 5,
        pollIntervalMs: 1,
        healthCheck: () => {
          calls += 1;
          const healthy = calls >= 3;
          probes.push(healthy);
          return healthy;
        },
      },
      { store, runner: serverRunner(), sleep: noSleep },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.url).toBe(url);
    expect(result.attempts).toBe(3);
    expect(probes).toEqual([false, false, true]);

    const events = await store.readRun('run-preview');
    expect(events.map((e) => e.type)).toEqual([
      'preview.starting',
      'preview.health_pending',
      'preview.ready',
    ]);
    // The URL only ever appears on the final preview.ready event.
    const ready = events.find((e) => e.type === 'preview.ready');
    expect((ready?.payload as { url: string }).url).toBe(url);

    await result.stop();
  });

  it('emits preview.failed (no url) when health never passes within the budget', async () => {
    const store = createInMemoryEventStore();
    const result = await startPreview(
      {
        runId: 'run-preview-fail',
        command: 'pnpm',
        args: ['preview'],
        url: 'http://127.0.0.1:5556',
        maxHealthAttempts: 3,
        pollIntervalMs: 1,
        healthCheck: () => false,
      },
      { store, runner: serverRunner(), sleep: noSleep },
    );

    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('url');

    const events = await store.readRun('run-preview-fail');
    const types = events.map((e) => e.type);
    expect(types).toContain('preview.failed');
    expect(types).not.toContain('preview.ready');

    await result.stop();
  });

  it('fails when the preview command exits before becoming healthy', async () => {
    const store = createInMemoryEventStore();
    // A runner that exits immediately with a non-zero code (a crash on boot).
    const crashingRunner: CommandRunner = {
      run: () => Promise.resolve({ code: 1, stdout: '', stderr: 'boom: missing build' }),
    };

    const result = await startPreview(
      {
        runId: 'run-preview-crash',
        command: 'pnpm',
        args: ['preview'],
        url: 'http://127.0.0.1:5557',
        maxHealthAttempts: 5,
        pollIntervalMs: 1,
        healthCheck: () => false,
      },
      { store, runner: crashingRunner, sleep: noSleep },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/exited early|boom/i);
    }
    const events = await store.readRun('run-preview-crash');
    expect(events.some((e) => e.type === 'preview.failed')).toBe(true);
    expect(events.some((e) => e.type === 'preview.ready')).toBe(false);
  });
});
