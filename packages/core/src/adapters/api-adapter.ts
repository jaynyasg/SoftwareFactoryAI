/**
 * Hosted/server-side API execution adapter (V1 stub).
 *
 * Behind the SAME `ExecutionAdapter` contract as the local CLI adapters, this is
 * the seam for future hosted execution. By default it reports `unavailable` and
 * needs-config (no endpoint/credentials), and `execute` returns a normalized
 * `unavailable` failure — so nothing can accidentally route real work to an
 * unconfigured hosted backend. Tests (and future wiring) inject `stubExecute`
 * (and/or mark it ready) so the adapter satisfies the shared contract tests.
 */
import { AdapterError } from './adapter-errors';
import type {
  AdapterExecuteOptions,
  AdapterFamily,
  AdapterResult,
  AdapterSetupState,
  AdapterTask,
  DetectSetupOptions,
  ExecutionAdapter,
  SetupAction,
} from './execution-adapter';

/** Options for constructing the API adapter stub. */
export interface ApiAdapterOptions {
  readonly id?: string;
  readonly family?: AdapterFamily;
  /** Hosted endpoint; absence is treated as needs-config. */
  readonly endpoint?: string;
  /** Credential; absence is treated as unauthenticated. */
  readonly apiKey?: string;
  /** Declared concurrency when configured (defaults to 8). */
  readonly capacity?: number;
  /**
   * Injected executor used in tests / future wiring. When provided, the adapter
   * reports available+authenticated and delegates `execute` to it.
   */
  readonly stubExecute?: (task: AdapterTask, opts: AdapterExecuteOptions) => Promise<AdapterResult>;
}

const DEFAULT_CAPACITY = 8;

const CONFIG_ACTIONS: readonly SetupAction[] = [
  {
    id: 'api.configure-endpoint',
    title: 'Configure the hosted execution endpoint',
    description: 'Set the API endpoint for hosted/server-side execution.',
  },
  {
    id: 'api.set-credentials',
    title: 'Provide hosted execution credentials',
    description: 'Set the API key/token for the hosted execution service.',
  },
];

/** Create the hosted API execution adapter (a stub until hosted wiring lands). */
export function createApiAdapter(options: ApiAdapterOptions = {}): ExecutionAdapter {
  const id = options.id ?? 'api-stub';
  const family = options.family ?? 'api';
  const capacity = Math.max(1, Math.trunc(options.capacity ?? DEFAULT_CAPACITY));
  const configured =
    options.stubExecute !== undefined ||
    (options.endpoint !== undefined && options.apiKey !== undefined);

  function detectSetup(_options?: DetectSetupOptions): Promise<AdapterSetupState> {
    if (!configured) {
      return Promise.resolve({
        available: false,
        authenticated: false,
        capacity: 0,
        setupActions: CONFIG_ACTIONS,
        detail: 'Hosted execution is not configured (missing endpoint/credentials).',
      });
    }
    return Promise.resolve({
      available: true,
      authenticated: true,
      capacity,
      detail: 'Hosted execution stub is configured.',
    });
  }

  async function execute(task: AdapterTask, opts: AdapterExecuteOptions): Promise<AdapterResult> {
    if (opts.signal.aborted) {
      return { ok: false, error: AdapterError.cancelled() };
    }
    if (options.stubExecute !== undefined) {
      return options.stubExecute(task, opts);
    }
    return {
      ok: false,
      error: AdapterError.unavailable(
        'Hosted API execution is not yet implemented; configure a hosted backend or use a local CLI adapter.',
      ),
    };
  }

  return {
    id,
    family,
    detectSetup,
    execute,
    reportCapacity(): number {
      return configured ? capacity : 0;
    },
  };
}
