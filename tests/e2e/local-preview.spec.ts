/**
 * Local-preview e2e (U6) — exercises the preview server end to end over REAL
 * HTTP, with NO browser binaries.
 *
 * It starts a throwaway fixture HTTP server (tests/fixtures/preview-fixture-server.mjs)
 * as a real child process via the production Node CommandRunner, driven by the
 * preview-server. The fixture is UNHEALTHY for a moment after boot, so this spec
 * proves the preview URL is exposed ONLY after the health check passes (at least
 * one failing probe precedes success), then GETs the exposed URL to confirm it
 * actually serves. Uses Playwright's `request` context (no page) on an ephemeral
 * 127.0.0.1 port; the child is torn down in afterAll.
 */
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { createInMemoryEventStore, createNodeCommandRunner } from '@software-factory/core';
import { startPreview } from '@software-factory/worker';
import type { PreviewResult } from '@software-factory/worker';

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'preview-fixture-server.mjs',
);

/** Reserve a free loopback port by briefly binding and releasing it. */
function reserveLoopbackPort(): Promise<number> {
  return new Promise<number>((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address !== null && typeof address === 'object') {
        const { port } = address;
        probe.close(() => resolvePort(port));
      } else {
        probe.close(() => reject(new Error('Could not reserve a loopback port.')));
      }
    });
  });
}

let preview: PreviewResult | undefined;

test.afterAll(async () => {
  await preview?.stop();
});

test('exposes the preview URL only after local health passes, then serves it', async ({
  request,
}) => {
  const port = await reserveLoopbackPort();
  const url = `http://127.0.0.1:${port}`;
  const store = createInMemoryEventStore();
  const probes: boolean[] = [];

  preview = await startPreview(
    {
      runId: 'run-local-preview-e2e',
      // Run the fixture directly with this Node binary (direct child => clean kill).
      command: process.execPath,
      args: [FIXTURE],
      env: { PORT: String(port), HEALTHY_AFTER_MS: '500' },
      url,
      maxHealthAttempts: 100,
      pollIntervalMs: 100,
      healthCheck: async ({ url: target }) => {
        try {
          const response = await request.get(`${target}/health`);
          const healthy = response.ok();
          probes.push(healthy);
          return healthy;
        } catch {
          probes.push(false);
          return false;
        }
      },
    },
    { store, runner: createNodeCommandRunner() },
  );

  expect(preview.ok).toBe(true);
  if (!preview.ok) {
    return;
  }
  expect(preview.url).toBe(url);

  // The URL appeared ONLY after health passed: at least one failing probe came
  // first, and the last probe (the one that unblocked the URL) succeeded.
  expect(probes.some((healthy) => healthy === false)).toBe(true);
  expect(probes[probes.length - 1]).toBe(true);

  // Ledger sequence: starting -> health_pending -> ready (url only on ready).
  const events = await store.readRun('run-local-preview-e2e');
  expect(events.map((event) => event.type)).toEqual([
    'preview.starting',
    'preview.health_pending',
    'preview.ready',
  ]);
  const ready = events.find((event) => event.type === 'preview.ready');
  expect((ready?.payload as { url: string }).url).toBe(url);

  // The exposed URL actually serves over real HTTP.
  const root = await request.get(url);
  expect(root.status()).toBe(200);
  expect(await root.text()).toContain('preview');

  const health = await request.get(`${url}/health`);
  expect(health.status()).toBe(200);
});
