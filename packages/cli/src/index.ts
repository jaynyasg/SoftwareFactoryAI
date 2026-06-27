#!/usr/bin/env node
/**
 * `software-factory` CLI entry point.
 *
 * Surface:
 *   software-factory start    [--port <n>] [--no-spawn] [--base-url <url>] [--json]
 *   software-factory run      <prompt> | --prd <path> | --request <json> | --request-file <path>
 *                             [--review-mode human|autonomous] [--worker-cap <1-10>]
 *                             [--title <t>] [--caller-family claude|codex|api]
 *                             [--no-follow] [--json]
 *   software-factory status   <runId> [--json]
 *   software-factory events   <runId> [--follow] [--since <n>] [--json]
 *   software-factory artifacts <runId> [--json]
 *
 * Global: --base-url <url> (or SF_BASE_URL, default http://127.0.0.1:3000),
 *         --operator-token <t> (or SF_OPERATOR_TOKEN; else the shared
 *         .factory/operator-token.json), --csrf-token <t> (or SF_CSRF_TOKEN).
 *
 * The CLI shares the operator session with the web UI by reading the same
 * file-backed token, so once a backend is running both authenticate as the same
 * local operator.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CallerFamily, ReviewMode } from '@software-factory/core';
import { createApiClient } from './api-client';
import { ApiError } from './api-client';
import { processIo, sleep } from './cli-io';
import type { CliIo } from './cli-io';
import { loadOperatorToken } from './operator-token';
import { runCommand } from './commands/run';
import { statusCommand } from './commands/status';
import { eventsCommand } from './commands/events';
import { artifactsCommand } from './commands/artifacts';
import { startCommand } from './commands/start';
import type { SpawnedBackend } from './commands/start';

/** Stable package identifier for the factory CLI. */
export const CLI_PACKAGE_NAME = '@software-factory/cli' as const;

export const DEFAULT_BASE_URL = 'http://127.0.0.1:3000';

interface ParsedArgs {
  readonly command?: string;
  readonly positionals: readonly string[];
  readonly flags: ReadonlyMap<string, string | true>;
}

/**
 * Known BOOLEAN flags. These are set to `true` without consuming the next token,
 * so a bare `--json`/`--no-follow` before a positional never swallows it.
 */
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  'json',
  'follow',
  'no-follow',
  'no-spawn',
  'help',
]);

/** Minimal argv parser: `--key value`, `--key=value`, `--flag`, `--no-flag`. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  let command: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const body = token.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) {
        flags.set(body.slice(0, eq), body.slice(eq + 1));
      } else if (BOOLEAN_FLAGS.has(body)) {
        // A known boolean flag never consumes the following token (a positional).
        flags.set(body, true);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        flags.set(body, argv[i + 1]);
        i += 1;
      } else {
        flags.set(body, true);
      }
    } else if (command === undefined) {
      command = token;
    } else {
      positionals.push(token);
    }
  }

  return { command, positionals, flags };
}

function flagStr(flags: ParsedArgs['flags'], name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function flagNum(flags: ParsedArgs['flags'], name: string): number | undefined {
  const value = flagStr(flags, name);
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function flagBool(flags: ParsedArgs['flags'], name: string): boolean {
  return flags.get(name) === true || flags.get(name) === 'true';
}

function asReviewMode(value: string | undefined): ReviewMode | undefined {
  return value === 'human' || value === 'autonomous' ? value : undefined;
}

function asCallerFamily(value: string | undefined): CallerFamily | undefined {
  return value === 'claude' || value === 'codex' || value === 'api' ? value : undefined;
}

/** Walk up from `start` to the pnpm workspace root (the dir with the lockfile). */
function resolveWorkspaceRoot(start: string = process.cwd()): string | undefined {
  let dir = start;
  for (let depth = 0; depth < 10; depth += 1) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return undefined;
}

/**
 * Spawn the standalone backend via `node --import tsx <standalone.ts>`, detached
 * so it outlives this CLI invocation. We poll reachability afterwards rather than
 * parse the child's stdout, so its streams are ignored.
 */
function spawnStandalone(baseUrl: string): (options: { port?: number }) => Promise<SpawnedBackend> {
  return ({ port }) => {
    const root = resolveWorkspaceRoot();
    if (root === undefined) {
      return Promise.reject(new Error('Could not locate the workspace root (pnpm-workspace.yaml).'));
    }
    const standalone = join(root, 'packages', 'web', 'src', 'server', 'standalone.ts');
    const env = { ...process.env };
    if (port !== undefined) {
      env.SF_PORT = String(port);
    }
    const child = spawn(process.execPath, ['--import', 'tsx', standalone], {
      cwd: root,
      env,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    const url = port !== undefined ? `http://127.0.0.1:${port}` : baseUrl;
    return Promise.resolve({ pid: child.pid, url });
  };
}

const HELP = `software-factory — local-first software factory CLI

Usage:
  software-factory start     [--port <n>] [--no-spawn] [--base-url <url>] [--json]
  software-factory run       <prompt> | --prd <path> | --request <json> | --request-file <path>
                             [--review-mode human|autonomous] [--worker-cap <1-10>]
                             [--title <t>] [--caller-family claude|codex|api] [--no-follow] [--json]
  software-factory status    <runId> [--json]
  software-factory events    <runId> [--follow] [--since <n>] [--json]
  software-factory artifacts <runId> [--json]

Environment:
  SF_BASE_URL         backend base URL (default ${DEFAULT_BASE_URL})
  SF_OPERATOR_TOKEN   operator token override (else .factory/operator-token.json)
  SF_CSRF_TOKEN       CSRF token (only for browser-style servers)
  SF_FACTORY_DIR      override the shared .factory directory`;

export interface RunCliDeps {
  readonly io?: CliIo;
  readonly env?: NodeJS.ProcessEnv;
}

/** Execute the CLI for `argv` (the args after the program name). */
export async function runCli(argv: readonly string[], deps: RunCliDeps = {}): Promise<number> {
  const io = deps.io ?? processIo;
  const env = deps.env ?? process.env;
  const parsed = parseArgs(argv);
  const { command, positionals, flags } = parsed;

  if (command === undefined || command === 'help' || flagBool(flags, 'help')) {
    io.out(HELP);
    return 0;
  }

  const baseUrl = flagStr(flags, 'base-url') ?? env.SF_BASE_URL ?? DEFAULT_BASE_URL;
  const json = flagBool(flags, 'json');
  // `--no-follow` sets the `no-follow` flag to true; default follow is true.
  const follow = !flagBool(flags, 'no-follow');

  async function buildClient(): Promise<ReturnType<typeof createApiClient>> {
    const operatorToken =
      flagStr(flags, 'operator-token') ?? (await loadOperatorToken({ env })) ?? undefined;
    const csrfToken = flagStr(flags, 'csrf-token') ?? env.SF_CSRF_TOKEN;
    return createApiClient({ baseUrl, operatorToken, csrfToken });
  }

  try {
    switch (command) {
      case 'start': {
        await startCommand(
          {
            baseUrl,
            port: flagNum(flags, 'port'),
            spawn: !flagBool(flags, 'no-spawn'),
            json,
            waitMs: flagNum(flags, 'wait-ms'),
          },
          { io, spawnStandalone: spawnStandalone(baseUrl) },
        );
        return 0;
      }
      case 'run': {
        const client = await buildClient();
        await runCommand(
          {
            prompt: positionals[0] ?? flagStr(flags, 'prompt'),
            prdPath: flagStr(flags, 'prd'),
            requestJson: flagStr(flags, 'request'),
            requestPath: flagStr(flags, 'request-file'),
            title: flagStr(flags, 'title'),
            reviewMode: asReviewMode(flagStr(flags, 'review-mode')),
            workerCap: flagNum(flags, 'worker-cap'),
            callerFamily: asCallerFamily(flagStr(flags, 'caller-family')),
            idempotencyKey: flagStr(flags, 'idempotency-key'),
            follow,
            json,
            pollIntervalMs: flagNum(flags, 'poll-interval-ms'),
            maxWaitMs: flagNum(flags, 'max-wait-ms'),
          },
          { client, io },
        );
        return 0;
      }
      case 'status': {
        const runId = positionals[0];
        if (runId === undefined) {
          io.err('status requires a <runId>.');
          return 2;
        }
        const client = await buildClient();
        await statusCommand({ runId, json }, { client, io });
        return 0;
      }
      case 'events': {
        const runId = positionals[0];
        if (runId === undefined) {
          io.err('events requires a <runId>.');
          return 2;
        }
        const client = await buildClient();
        await eventsCommand(
          {
            runId,
            follow: flagBool(flags, 'follow'),
            since: flagNum(flags, 'since'),
            json,
            pollIntervalMs: flagNum(flags, 'poll-interval-ms'),
            maxWaitMs: flagNum(flags, 'max-wait-ms'),
          },
          { client, io },
        );
        return 0;
      }
      case 'artifacts': {
        const runId = positionals[0];
        if (runId === undefined) {
          io.err('artifacts requires a <runId>.');
          return 2;
        }
        const client = await buildClient();
        await artifactsCommand({ runId, json }, { client, io });
        return 0;
      }
      default: {
        io.err(`Unknown command: ${command}\n`);
        io.out(HELP);
        return 2;
      }
    }
  } catch (error) {
    if (error instanceof ApiError) {
      const hint = error.isAuthFailure
        ? ' (check the operator token; run `software-factory start` first)'
        : error.isStale
          ? ' (reload current state and retry)'
          : '';
      io.err(`error: ${error.code} — ${error.message}${hint}`);
      return 1;
    }
    io.err(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

// Run only when executed directly (tsx/node), not when imported by a test.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  void runCli(process.argv.slice(2), { io: processIo })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`fatal: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}

// Re-exports so embedders/tests can import the surface from the package root.
export { sleep };
export { createApiClient, ApiError } from './api-client';
export type { ApiClient } from './api-client';
export { loadOperatorToken, resolveFactoryDir, operatorTokenPath } from './operator-token';
export { buildRunOutputs } from './run-outputs';
export type { RunOutputs } from './run-outputs';
export { runCommand } from './commands/run';
export { statusCommand } from './commands/status';
export { eventsCommand } from './commands/events';
export { artifactsCommand } from './commands/artifacts';
export { startCommand, reachable } from './commands/start';
