/**
 * `software-factory start` — ensure a local backend is running.
 *
 * If `SF_BASE_URL` is already reachable, the CLI just connects (the web dev
 * server or an earlier `start` already serves the API). Otherwise it boots a
 * standalone loopback backend (packages/web/src/server/standalone.ts via tsx),
 * which shares the SAME `.factory/` store and operator token as the web UI, then
 * waits until it answers.
 *
 * Reachability and spawning are injected so this is unit-testable without a real
 * server or child process; `index.ts` supplies the real `fetch` + spawn wiring.
 */
import type { CliIo } from '../cli-io';

export type FetchLike = typeof fetch;

/** Bounded timeout for a single reachability probe (keeps the start loop bounded). */
const REACHABLE_TIMEOUT_MS = 5_000;

/** Probe a backend's read-only setup route; never throws. */
export async function reachable(baseUrl: string, fetchImpl: FetchLike): Promise<boolean> {
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/api/setup`, {
      method: 'GET',
      signal: AbortSignal.timeout(REACHABLE_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface SpawnedBackend {
  /** URL the spawned backend reported (if it printed one), else undefined. */
  readonly url?: string;
  readonly pid?: number;
}

export interface StartCommandArgs {
  readonly baseUrl: string;
  readonly port?: number;
  /** Boot a standalone backend when unreachable (default true). */
  readonly spawn?: boolean;
  readonly json?: boolean;
  /** How long to wait for a spawned backend to answer. */
  readonly waitMs?: number;
  readonly pollIntervalMs?: number;
}

export interface StartCommandDeps {
  readonly io: CliIo;
  readonly fetchImpl?: FetchLike;
  /** Spawns the standalone backend; resolves once the child is launched. */
  readonly spawnStandalone?: (options: { port?: number }) => Promise<SpawnedBackend>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

export interface StartResult {
  readonly status: 'connected' | 'spawned' | 'unavailable';
  readonly baseUrl: string;
  readonly message: string;
}

export async function startCommand(
  args: StartCommandArgs,
  deps: StartCommandDeps,
): Promise<StartResult> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;

  const emit = (result: StartResult): StartResult => {
    deps.io.out(args.json === true ? JSON.stringify(result) : result.message);
    return result;
  };

  if (await reachable(args.baseUrl, fetchImpl)) {
    return emit({
      status: 'connected',
      baseUrl: args.baseUrl,
      message: `Connected to existing backend at ${args.baseUrl}.`,
    });
  }

  if (args.spawn === false || deps.spawnStandalone === undefined) {
    return emit({
      status: 'unavailable',
      baseUrl: args.baseUrl,
      message:
        `No backend reachable at ${args.baseUrl}. Start one with \`pnpm dev\` (web UI) or ` +
        '`pnpm --filter @software-factory/web exec tsx src/server/standalone.ts`.',
    });
  }

  deps.io.err(`No backend at ${args.baseUrl}; booting a standalone backend…`);
  const spawned = await deps.spawnStandalone({ port: args.port });
  const targetUrl = spawned.url ?? args.baseUrl;

  const deadline = now() + (args.waitMs ?? 15_000);
  const pollIntervalMs = args.pollIntervalMs ?? 250;
  for (;;) {
    if (await reachable(targetUrl, fetchImpl)) {
      return emit({
        status: 'spawned',
        baseUrl: targetUrl,
        message: `Started standalone backend at ${targetUrl}.`,
      });
    }
    if (now() >= deadline) {
      return emit({
        status: 'unavailable',
        baseUrl: targetUrl,
        message: `Standalone backend did not become reachable at ${targetUrl} in time.`,
      });
    }
    await sleep(pollIntervalMs);
  }
}
