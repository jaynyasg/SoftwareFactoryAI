/**
 * Preview-health gate: passes ONLY when an injected health probe reports the
 * preview healthy. The probe (and the wait between polls) are injectable so the
 * gate is unit-tested deterministically with no network and no real sleeps.
 *
 * This is the blocking gate form of the health check; the long-running preview
 * process itself is started/owned by `preview-server`.
 */
import type { Gate, GateContext, GateResult } from './command-gate';

/** Context passed to a health probe. */
export interface PreviewHealthProbeContext {
  readonly attempt: number;
  readonly url: string;
  readonly signal?: AbortSignal;
}

/** An injectable health probe returning whether the preview is healthy. */
export type PreviewHealthProbe = (ctx: PreviewHealthProbeContext) => Promise<boolean> | boolean;

/** Options for the preview-health gate. */
export interface PreviewHealthGateOptions {
  /** The preview URL whose health is being checked (carried in evidence). */
  readonly url: string;
  readonly probe: PreviewHealthProbe;
  /** Max poll attempts (default 1; the preview is normally already up). */
  readonly attempts?: number;
  /** Delay between polls in ms (default 0). */
  readonly pollIntervalMs?: number;
  /** Injectable wait (default a real, abortable timer). */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolvePromise) => {
    if (ms <= 0 || signal?.aborted) {
      resolvePromise();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolvePromise();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolvePromise();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Create the preview-health gate. */
export function createPreviewHealthGate(options: PreviewHealthGateOptions): Gate {
  const attempts = Math.max(1, Math.trunc(options.attempts ?? 1));
  const sleep = options.sleep ?? defaultSleep;

  return {
    name: 'preview-health',
    async run(ctx: GateContext): Promise<GateResult> {
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const healthy = await options.probe({ attempt, url: options.url, signal: ctx.signal });
        if (healthy) {
          return {
            gate: 'preview-health',
            passed: true,
            summary: `Preview healthy at ${options.url}.`,
            evidence: [
              {
                label: 'preview-health',
                ref: options.url,
                detail: `healthy after ${attempt} attempt(s)`,
              },
            ],
          };
        }
        if (attempt < attempts) {
          await sleep(options.pollIntervalMs ?? 0, ctx.signal);
        }
      }

      return {
        gate: 'preview-health',
        passed: false,
        reason: `Preview did not report healthy at ${options.url} within ${attempts} attempt(s).`,
        evidence: [{ label: 'preview-health', ref: options.url, detail: 'unhealthy' }],
      };
    },
  };
}
