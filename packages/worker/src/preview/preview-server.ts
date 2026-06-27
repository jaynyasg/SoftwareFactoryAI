/**
 * Local preview server.
 *
 * `startPreview` boots the generated app's preview command (through the injected
 * `CommandRunner` — the same abstraction the CLI adapters use, which a sandbox
 * may wrap), then polls an INJECTED health check until success or timeout, and
 * exposes the preview URL ONLY AFTER health succeeds. The ledger sequence is:
 *
 *   preview.starting -> preview.health_pending -> preview.ready { url }
 *                                              \-> preview.failed { reason }
 *
 * The URL is never emitted before `preview.ready`. The preview command is a
 * long-running process: its `run()` promise is NOT awaited (it would only settle
 * on exit); instead we watch for an early exit (a crash before health) and treat
 * it as a failure. The returned handle's `stop()` aborts the process. The health
 * check and the inter-poll wait are injectable, so tests are deterministic with
 * no real network and no real sleeps.
 */
import type {
  AppendableEvent,
  CommandRunner,
  EventActor,
  EventStore,
} from '@software-factory/core';

/** Context passed to the injected health check. */
export interface PreviewHealthCheckContext {
  readonly attempt: number;
  readonly url: string;
  readonly signal: AbortSignal;
}

/** Returns whether the preview is healthy yet (no throw — errors mean not-ready). */
export type PreviewHealthCheck = (ctx: PreviewHealthCheckContext) => Promise<boolean> | boolean;

/** Parameters for starting a preview. */
export interface StartPreviewParams {
  readonly runId: string;
  readonly ticketId?: string;
  /** The preview command (e.g. `pnpm`, or a node binary). */
  readonly command: string;
  readonly args?: readonly string[];
  /** Working directory for the preview command. */
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  /** The preview URL — exposed ONLY after health passes. */
  readonly url: string;
  /** Injected health check (polled until healthy or budget exhausted). */
  readonly healthCheck: PreviewHealthCheck;
  /** Max health poll attempts (default 30). */
  readonly maxHealthAttempts?: number;
  /** Delay between health polls in ms (default 250). */
  readonly pollIntervalMs?: number;
}

/** Dependencies for starting a preview (the seams tests substitute). */
export interface PreviewDeps {
  readonly store: EventStore;
  readonly runner: CommandRunner;
  readonly clock?: () => number;
  /** Injectable wait between polls (default a real, abortable timer). */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** A handle to tear down a running preview. */
export interface PreviewHandle {
  /** Stop the preview process (idempotent). */
  stop(): Promise<void>;
}

/** The result of `startPreview`: a URL only on success, plus a teardown handle. */
export type PreviewResult =
  | (PreviewHandle & { readonly ok: true; readonly url: string; readonly attempts: number })
  | (PreviewHandle & { readonly ok: false; readonly reason: string; readonly attempts: number });

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolvePromise) => {
    if (ms <= 0 || signal.aborted) {
      resolvePromise();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolvePromise();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolvePromise();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function tail(text: string, max = 300): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `…${trimmed.slice(trimmed.length - (max - 1))}`;
}

/**
 * Start a preview, polling health until ready or timeout. The preview URL is
 * exposed only on `ok: true` (after `preview.ready`).
 */
export async function startPreview(
  params: StartPreviewParams,
  deps: PreviewDeps,
): Promise<PreviewResult> {
  const actor: EventActor = { kind: 'system', id: 'preview', display: 'preview-server' };
  const subject = { kind: 'preview', id: params.runId };
  const sleep = deps.sleep ?? defaultSleep;
  const maxAttempts = Math.max(1, Math.trunc(params.maxHealthAttempts ?? 30));

  const append = (event: Omit<AppendableEvent, 'runId' | 'ticketId'>): Promise<unknown> =>
    deps.store.append({
      ...event,
      runId: params.runId,
      ticketId: params.ticketId,
      timestamp: deps.clock?.(),
    } as AppendableEvent);

  const controller = new AbortController();
  let stopping = false;
  let exited = false;
  let exitReason: string | undefined;

  await append({ type: 'preview.starting', actor, subject, severity: 'info', payload: {} });

  // Kick off the long-running preview command; do NOT await it. Observe its
  // settlement so an early crash (before health) becomes a failure, and so the
  // abort-on-stop rejection is never an unhandled rejection.
  const processPromise: Promise<void> = deps.runner
    .run(params.command, params.args ?? [], {
      cwd: params.cwd,
      env: params.env,
      signal: controller.signal,
    })
    .then(
      (result) => {
        exited = true;
        if (!stopping) {
          exitReason =
            `Preview command exited early (code ${result.code}). ${tail(result.stderr)}`.trim();
        }
      },
      (error) => {
        exited = true;
        if (!stopping) {
          exitReason = `Preview command failed: ${messageOf(error)}`;
        }
      },
    );

  const stop = async (): Promise<void> => {
    if (!stopping) {
      stopping = true;
      controller.abort();
    }
    await processPromise;
  };

  await append({ type: 'preview.health_pending', actor, subject, severity: 'info', payload: {} });

  let attempts = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attempts = attempt;

    if (exited && !stopping) {
      const reason = exitReason ?? 'Preview command exited before becoming healthy.';
      await append({
        type: 'preview.failed',
        actor,
        subject,
        severity: 'error',
        payload: { reason },
      });
      return { ok: false, reason, attempts, stop };
    }

    let healthy = false;
    try {
      healthy = await params.healthCheck({ attempt, url: params.url, signal: controller.signal });
    } catch {
      healthy = false;
    }

    if (healthy) {
      await append({
        type: 'preview.ready',
        actor,
        subject,
        severity: 'success',
        evidence: [{ label: 'preview-url', href: params.url, ref: params.url }],
        payload: { url: params.url },
      });
      return { ok: true, url: params.url, attempts, stop };
    }

    if (attempt < maxAttempts) {
      await sleep(params.pollIntervalMs ?? 250, controller.signal);
    }
  }

  await stop();
  const reason = `Preview did not become healthy at ${params.url} after ${maxAttempts} attempt(s).`;
  await append({ type: 'preview.failed', actor, subject, severity: 'error', payload: { reason } });
  return { ok: false, reason, attempts, stop };
}
