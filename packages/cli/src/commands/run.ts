/**
 * `software-factory run` — create a run and report its artifact contract.
 *
 * Accepts a prompt string, a PRD file path (`--prd`), or a JSON request
 * (`--request` inline or `--request-file`). Creates the run (a guarded mutation
 * authenticated by the operator token), streams the ledger with resume/reconnect
 * while it settles (V1 is planning-only, so it settles at `planned` with a
 * ticket DAG), then prints the stable artifact-output contract: run id, local
 * preview URL, hosted URL (when ready), repo artifact path, tests summary,
 * handoff markdown reference, and the events URL.
 *
 * `--caller-family <claude|codex|api>` is forwarded to the backend so nested-
 * agent metadata is attributed to the run (and matched against the selected
 * worker adapter family if/when live execution runs).
 */
import { readFile as fsReadFile } from 'node:fs/promises';
import type { CallerFamily, ReviewMode } from '@software-factory/core';
import type { ApiClient, CreateRunInput } from '../api-client';
import type { CliIo } from '../cli-io';
import { formatEventLine, formatRunOutputs } from '../cli-io';
import { streamRunEvents } from '../stream';
import { buildRunOutputs } from '../run-outputs';
import type { RunOutputs } from '../run-outputs';

export interface RunCommandArgs {
  /** Positional / `--prompt` prompt text. */
  readonly prompt?: string;
  /** `--prd <path>`: read a PRD file as the run's prompt (path kept as prdRef). */
  readonly prdPath?: string;
  /** `--request <json>`: inline JSON request body. */
  readonly requestJson?: string;
  /** `--request-file <path>`: JSON request body from a file. */
  readonly requestPath?: string;
  readonly title?: string;
  readonly reviewMode?: ReviewMode;
  readonly workerCap?: number;
  readonly callerFamily?: CallerFamily;
  readonly idempotencyKey?: string;
  /** Stream events while the run settles (default true). */
  readonly follow?: boolean;
  /** Emit the contract as JSON on stdout (default false → human text). */
  readonly json?: boolean;
  readonly pollIntervalMs?: number;
  readonly maxWaitMs?: number;
}

export interface RunCommandDeps {
  readonly client: ApiClient;
  readonly io: CliIo;
  readonly readFile?: (path: string) => Promise<string>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

function parseRequestJson(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON request: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('JSON request must be an object.');
  }
  return parsed as Record<string, unknown>;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function reviewMode(value: unknown): ReviewMode | undefined {
  return value === 'human' || value === 'autonomous' ? value : undefined;
}

/** Resolve the create-run input from the various intake forms (flags win). */
async function resolveCreateInput(
  args: RunCommandArgs,
  readFile: (path: string) => Promise<string>,
): Promise<CreateRunInput> {
  let base: Record<string, unknown> = {};
  if (args.requestJson !== undefined) {
    base = parseRequestJson(args.requestJson);
  } else if (args.requestPath !== undefined) {
    base = parseRequestJson(await readFile(args.requestPath));
  } else if (args.prdPath !== undefined) {
    const content = await readFile(args.prdPath);
    base = { prompt: content, prdRef: args.prdPath };
  } else if (args.prompt !== undefined) {
    base = { prompt: args.prompt };
  }

  const input: CreateRunInput = {
    prompt: args.prompt ?? str(base.prompt),
    prdRef: str(base.prdRef) ?? (args.prdPath !== undefined ? args.prdPath : undefined),
    title: args.title ?? str(base.title),
    requestedWorkerCap: args.workerCap ?? num(base.requestedWorkerCap),
    reviewMode: args.reviewMode ?? reviewMode(base.reviewMode),
    callerFamily: args.callerFamily,
    idempotencyKey: args.idempotencyKey,
  };

  // When a PRD/JSON supplies the prompt, the positional prompt is absent; prefer
  // the resolved base prompt in that case.
  if (input.prompt === undefined && typeof base.prompt === 'string') {
    return { ...input, prompt: base.prompt };
  }
  if (input.prompt === undefined && input.prdRef === undefined) {
    throw new Error('Provide a prompt, a --prd <path>, or a --request/--request-file JSON body.');
  }
  return input;
}

export async function runCommand(args: RunCommandArgs, deps: RunCommandDeps): Promise<RunOutputs> {
  const { client, io } = deps;
  const readFile = deps.readFile ?? ((path: string) => fsReadFile(path, 'utf8'));
  const follow = args.follow ?? true;

  const input = await resolveCreateInput(args, readFile);
  const created = await client.createRun(input);
  io.err(`Created run ${created.runId} (${created.deduplicated ? 'existing' : 'new'}).`);

  if (follow) {
    await streamRunEvents(client, created.runId, {
      sleep: deps.sleep,
      now: deps.now,
      pollIntervalMs: args.pollIntervalMs,
      maxWaitMs: args.maxWaitMs,
      onEvent: (event) => io.err(formatEventLine(event)),
      onReconnect: (attempt, lastSequence) =>
        io.err(`reconnecting (attempt ${attempt}); resuming from sequence ${lastSequence}…`),
    });
  }

  // Build the contract from the authoritative full log.
  const { events } = await client.getEvents(created.runId);
  const outputs = buildRunOutputs(created.runId, events, client.eventsUrl(created.runId));
  io.out(args.json === true ? JSON.stringify(outputs, null, 2) : formatRunOutputs(outputs));
  return outputs;
}
