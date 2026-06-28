/**
 * CLI + skill-wrapper e2e — browser-free, no real Codex/Claude CLI.
 *
 * Boots the framework-agnostic backend in-process on an ephemeral loopback port
 * (createApp.listen) with an in-memory store and a KNOWN operator token, and NO
 * CSRF token — exactly the standalone backend the CLI's `start` boots, so the CLI
 * authenticates with the operator token alone. The default genome planner runs,
 * so a created run gets a real ticket DAG.
 *
 * Then it drives the actual `software-factory` CLI as a subprocess (via tsx) to:
 *   - create a run from a prompt (assert run_id + planned ticket DAG events),
 *   - stream events with resume, and return the final artifact outputs (a
 *     completed run is seeded directly into the store to assert preview/repo/
 *     handoff/deploy outputs), and
 *   - prove a token mismatch blocks a mutating command before side effects.
 * Finally it asserts the Claude and Codex wrappers call the SAME CLI/backend path
 * and return the SAME artifact contract (differing only by caller family).
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  createInMemoryEventStore,
  createInMemoryOperatorTokenStore,
  createOperatorTokenProvider,
  type AppendableEvent,
  type EventStore,
} from '@software-factory/core';
import { createApp, type RunningServer } from '../../packages/web/src/server/app';

const TOKEN = 'cli-e2e-operator-token';
const MARKETPLACE_PROMPT =
  'Build an AI services marketplace with providers, proposals, and customer requests';

const repoRoot = process.cwd();
const cliEntry = join(repoRoot, 'packages', 'cli', 'src', 'index.ts');

let server: RunningServer | undefined;
let store: EventStore;
let baseURL = '';

interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run the real CLI as a subprocess via tsx; never throws on non-zero exit. */
function runCli(args: readonly string[], env: Record<string, string>): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', cliEntry, ...args], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function cliEnv(extra: Record<string, string> = {}): Record<string, string> {
  return { SF_BASE_URL: baseURL, SF_OPERATOR_TOKEN: TOKEN, ...extra };
}

async function countRunCreated(): Promise<number> {
  return (await store.readAll()).filter((event) => event.type === 'run.created').length;
}

/** Append a fully-formed COMPLETED run to the store so outputs are assertable. */
async function seedCompletedRun(runId: string): Promise<void> {
  const events: AppendableEvent[] = [
    {
      runId,
      type: 'run.created',
      actor: { kind: 'operator', id: 'operator' },
      subject: { kind: 'run', id: runId, version: 0 },
      severity: 'info',
      payload: { prompt: MARKETPLACE_PROMPT, reviewMode: 'human' },
    },
    {
      runId,
      type: 'run.planned',
      actor: { kind: 'supervisor', id: 'supervisor' },
      subject: { kind: 'run', id: runId },
      severity: 'info',
      payload: { ticketCount: 1 },
    },
    {
      runId,
      ticketId: 'tests',
      type: 'gate.passed',
      actor: { kind: 'gate', id: 'gate-runner' },
      subject: { kind: 'ticket', id: 'tests' },
      severity: 'success',
      payload: { gate: 'test', summary: '12 unit tests passed' },
    },
    {
      runId,
      ticketId: 'scaffold',
      type: 'artifact.created',
      actor: { kind: 'worker', id: 'worker' },
      subject: { kind: 'ticket', id: 'scaffold' },
      severity: 'info',
      payload: { artifactId: 'art-repo', kind: 'repo', path: 'generated/ai-marketplace' },
    },
    {
      runId,
      ticketId: 'scaffold',
      type: 'artifact.confidence_computed',
      actor: { kind: 'worker', id: 'worker' },
      subject: { kind: 'ticket', id: 'scaffold' },
      severity: 'info',
      payload: { artifactId: 'art-repo', confidence: 0.9 },
    },
    {
      runId,
      type: 'preview.ready',
      actor: { kind: 'worker', id: 'worker' },
      subject: { kind: 'run', id: runId },
      severity: 'success',
      payload: { url: 'http://127.0.0.1:4399' },
    },
    {
      runId,
      type: 'package.created',
      actor: { kind: 'worker', id: 'worker' },
      subject: { kind: 'run', id: runId },
      severity: 'success',
      payload: {
        repoPath: '/tmp/generated/ai-marketplace',
        handoffRef: 'generated/ai-marketplace/HANDOFF.md',
        summary: 'packaged with provenance',
      },
    },
    {
      runId,
      type: 'deploy.hosted_ready',
      actor: { kind: 'deploy', id: 'render' },
      subject: { kind: 'run', id: runId },
      severity: 'success',
      payload: { url: 'https://ai-marketplace.onrender.com' },
    },
    {
      runId,
      type: 'run.completed',
      actor: { kind: 'supervisor', id: 'supervisor' },
      subject: { kind: 'run', id: runId },
      severity: 'success',
      payload: { summary: 'all gates green; hosted health ok' },
    },
  ];
  for (const event of events) {
    await store.append(event);
  }
}

test.beforeAll(async () => {
  store = createInMemoryEventStore();
  const operatorToken = createOperatorTokenProvider({
    store: createInMemoryOperatorTokenStore({ token: TOKEN, createdAt: Date.now() }),
  });
  let runSeq = 0;
  // No CSRF token here (CLI is a non-browser caller authenticated by the token).
  const app = createApp({
    store,
    operatorToken,
    idGenerator: () => `cli-run-${(runSeq += 1)}`,
    config: { allowedOrigins: ['http://127.0.0.1:3000'] },
  });
  server = await app.listen(0);
  baseURL = server.url;
});

test.afterAll(async () => {
  await server?.close();
});

test('binds the backend to loopback for the CLI', () => {
  expect(baseURL.startsWith('http://127.0.0.1:')).toBe(true);
});

test('creates a run from a prompt and returns run_id + a planned ticket DAG', async () => {
  const result = await runCli(
    ['run', MARKETPLACE_PROMPT, '--json', '--poll-interval-ms', '10', '--max-wait-ms', '8000'],
    cliEnv(),
  );
  expect(result.code).toBe(0);

  const outputs = JSON.parse(result.stdout) as {
    runId: string;
    status: string;
    plannedTicketCount: number;
    tickets: { id: string }[];
    eventsUrl: string;
  };
  expect(outputs.runId).toBeTruthy();
  expect(outputs.status).toBe('planned');
  expect(outputs.plannedTicketCount).toBe(12);
  expect(outputs.tickets.map((t) => t.id)).toContain('scaffold');
  expect(outputs.tickets.map((t) => t.id)).toContain('deploy');
  expect(outputs.eventsUrl).toContain(`/api/runs/${outputs.runId}/events`);

  // Streamed events (progress on stderr) include the supervisor + DAG + capstone.
  expect(result.stderr).toContain('supervisor.decision');
  expect(result.stderr).toContain('ticket.created');
  expect(result.stderr).toContain('run.planned');
});

test('streams a run event log with resume (events command, JSONL)', async () => {
  const created = await runCli(['run', MARKETPLACE_PROMPT, '--no-follow', '--json'], cliEnv());
  expect(created.code).toBe(0);
  const runId = (JSON.parse(created.stdout) as { runId: string }).runId;

  const events = await runCli(['events', runId, '--json'], cliEnv());
  expect(events.code).toBe(0);
  const lines = events.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { type: string; sequence: number });

  expect(lines[0].type).toBe('run.created');
  expect(lines.map((e) => e.type)).toContain('run.planned');
  // Sequences are strictly increasing (resume cursor never re-emits an event).
  const sequences = lines.map((e) => e.sequence);
  expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
  expect(new Set(sequences).size).toBe(sequences.length);
});

test('returns final preview/repo/handoff/deploy outputs for a completed run', async () => {
  const runId = 'cli-e2e-completed';
  await seedCompletedRun(runId);

  const status = await runCli(['status', runId, '--json'], cliEnv());
  expect(status.code).toBe(0);
  const outputs = JSON.parse(status.stdout) as {
    status: string;
    previewUrl?: string;
    hostedUrl?: string;
    repoPath?: string;
    handoffRef?: string;
    tests: { passed: number };
  };
  expect(outputs.status).toBe('completed');
  expect(outputs.previewUrl).toBe('http://127.0.0.1:4399');
  expect(outputs.hostedUrl).toBe('https://ai-marketplace.onrender.com');
  expect(outputs.repoPath).toBe('/tmp/generated/ai-marketplace');
  expect(outputs.handoffRef).toBe('generated/ai-marketplace/HANDOFF.md');
  expect(outputs.tests.passed).toBeGreaterThanOrEqual(1);

  // The artifacts command surfaces the same delivery references.
  const artifacts = await runCli(['artifacts', runId, '--json'], cliEnv());
  expect(artifacts.code).toBe(0);
  const artifactResult = JSON.parse(artifacts.stdout) as { hostedUrl?: string; repoPath?: string };
  expect(artifactResult.hostedUrl).toBe('https://ai-marketplace.onrender.com');
  expect(artifactResult.repoPath).toBe('/tmp/generated/ai-marketplace');
});

test('token mismatch blocks a mutating command before side effects', async () => {
  const before = await countRunCreated();

  const result = await runCli(
    ['run', MARKETPLACE_PROMPT, '--json'],
    cliEnv({ SF_OPERATOR_TOKEN: 'wrong-token' }),
  );

  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain('invalid_token');

  // The guard rejects before writing run.created (no new run was created).
  const after = await countRunCreated();
  expect(after).toBe(before);
});

test('Claude and Codex wrappers call the same CLI/backend and return the same contract', async () => {
  // The wrappers are thin: they forward to the SAME CLI entry, only adding
  // --caller-family. Invoking the CLI with each family mirrors them exactly.
  const claude = await runCli(
    ['run', MARKETPLACE_PROMPT, '--caller-family', 'claude', '--json', '--poll-interval-ms', '10'],
    cliEnv(),
  );
  const codex = await runCli(
    ['run', MARKETPLACE_PROMPT, '--caller-family', 'codex', '--json', '--poll-interval-ms', '10'],
    cliEnv(),
  );
  expect(claude.code).toBe(0);
  expect(codex.code).toBe(0);

  const c1 = JSON.parse(claude.stdout) as Record<string, unknown>;
  const c2 = JSON.parse(codex.stdout) as Record<string, unknown>;
  // Same artifact contract shape…
  expect(Object.keys(c1).sort()).toEqual(Object.keys(c2).sort());
  // …differing only by the recorded caller family.
  expect(c1.callerFamily).toBe('claude');
  expect(c2.callerFamily).toBe('codex');
  expect(c1.plannedTicketCount).toBe(c2.plannedTicketCount);

  // And the wrapper scripts statically reference the same CLI entry + family flag.
  const sh = await readFile(join(repoRoot, 'skills/claude/scripts/software-factory.sh'), 'utf8');
  expect(sh).toContain('packages/cli/src/index.ts');
  expect(sh).toContain('--caller-family claude');
  expect(sh).toContain('SOFTWARE_FACTORY_REPO_ROOT');
  expect(sh).toContain('repo-root.txt');
  expect(sh).toContain('--no-spawn');
  const ps = await readFile(join(repoRoot, 'skills/codex/scripts/software-factory.ps1'), 'utf8');
  expect(ps).toContain('index.ts');
  expect(ps).toContain('caller-family');
  expect(ps).toContain('codex');
  expect(ps).toContain('SOFTWARE_FACTORY_REPO_ROOT');
  expect(ps).toContain('repo-root.txt');
  expect(ps).toContain('--no-spawn');
});
