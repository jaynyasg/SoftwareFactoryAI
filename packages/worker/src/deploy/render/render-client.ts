/**
 * A minimal Render API client behind an INJECTABLE HTTP transport.
 *
 * The client can: trigger a deploy, poll a deploy's status, and check the hosted
 * app's health. It never imports `fetch` at the call sites — it calls an
 * `HttpTransport`. The default transport wraps the global `fetch`, but tests
 * inject a mock transport (or mock the whole `RenderClient`), so NO real network
 * and NO Render credentials are required to exercise the deploy orchestration.
 */

/** A transport-agnostic HTTP request. */
export interface HttpRequest {
  readonly method: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

/** A transport-agnostic HTTP response. */
export interface HttpResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly body: string;
}

/** The injectable transport (default: a `fetch` wrapper). */
export type HttpTransport = (
  request: HttpRequest,
  options?: { readonly signal?: AbortSignal },
) => Promise<HttpResponse>;

/** Render deploy statuses (open union — Render may add more). */
export type RenderDeployStatus =
  | 'created'
  | 'queued'
  | 'build_in_progress'
  | 'update_in_progress'
  | 'live'
  | 'build_failed'
  | 'update_failed'
  | 'canceled'
  | 'deactivated'
  | (string & {});

/** A Render deploy record (the subset we use). */
export interface RenderDeploy {
  readonly id: string;
  readonly status: RenderDeployStatus;
  readonly commit?: string;
  /** A failure detail when the deploy failed (used to classify migration errors). */
  readonly failureReason?: string;
}

/** Hosted health-check result. */
export interface RenderHealthResult {
  readonly healthy: boolean;
  readonly status: number;
}

/** Arguments shared by deploy calls. */
export interface CreateDeployArgs {
  readonly serviceId: string;
  readonly clearCache?: boolean;
  readonly signal?: AbortSignal;
}

export interface GetDeployArgs {
  readonly serviceId: string;
  readonly deployId: string;
  readonly signal?: AbortSignal;
}

export interface CheckHealthArgs {
  readonly url: string;
  readonly signal?: AbortSignal;
}

/** The Render client contract the deployer depends on. */
export interface RenderClient {
  createDeploy(args: CreateDeployArgs): Promise<RenderDeploy>;
  getDeploy(args: GetDeployArgs): Promise<RenderDeploy>;
  checkHealth(args: CheckHealthArgs): Promise<RenderHealthResult>;
}

/** Options for the default Render client. */
export interface RenderClientOptions {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly transport?: HttpTransport;
}

export const DEFAULT_RENDER_BASE_URL = 'https://api.render.com/v1';

/** A terminal deploy status (no further polling needed). */
export function isTerminalDeployStatus(status: RenderDeployStatus): boolean {
  return (
    status === 'live' ||
    status === 'build_failed' ||
    status === 'update_failed' ||
    status === 'canceled' ||
    status === 'deactivated'
  );
}

/** Whether a terminal deploy status represents success. */
export function isDeploySuccess(status: RenderDeployStatus): boolean {
  return status === 'live';
}

/** The default transport: a thin wrapper over the global `fetch`. */
export function createFetchTransport(): HttpTransport {
  return async (request, options) => {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: options?.signal,
    });
    const body = await response.text();
    return { status: response.status, ok: response.ok, body };
  };
}

function parseDeploy(body: string): RenderDeploy {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`Render returned a non-JSON deploy payload: ${body.slice(0, 200)}`);
  }
  // Render may wrap the deploy as `{ deploy: {...} }` (list/create) or return it flat.
  const record =
    typeof parsed === 'object' && parsed !== null && 'deploy' in parsed
      ? (parsed as { deploy: unknown }).deploy
      : parsed;
  if (typeof record !== 'object' || record === null) {
    throw new Error('Render deploy payload was not an object.');
  }
  const deploy = record as Record<string, unknown>;
  const id = typeof deploy.id === 'string' ? deploy.id : '';
  const status = typeof deploy.status === 'string' ? (deploy.status as RenderDeployStatus) : 'created';
  return {
    id,
    status,
    commit: typeof deploy.commit === 'string' ? deploy.commit : undefined,
    failureReason: typeof deploy.failureReason === 'string' ? deploy.failureReason : undefined,
  };
}

/**
 * Create the default Render client. All HTTP goes through `transport`
 * (default `fetch`), so tests inject a mock and never hit the network.
 */
export function createRenderClient(options: RenderClientOptions = {}): RenderClient {
  const baseUrl = (options.baseUrl ?? DEFAULT_RENDER_BASE_URL).replace(/\/$/, '');
  const transport = options.transport ?? createFetchTransport();
  const authHeaders: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
    ...(options.apiKey !== undefined ? { authorization: `Bearer ${options.apiKey}` } : {}),
  };

  const ensureOk = (response: HttpResponse, context: string): void => {
    if (!response.ok) {
      throw new Error(`Render API ${context} failed (HTTP ${response.status}): ${response.body.slice(0, 200)}`);
    }
  };

  return {
    async createDeploy(args) {
      const response = await transport(
        {
          method: 'POST',
          url: `${baseUrl}/services/${args.serviceId}/deploys`,
          headers: authHeaders,
          body: JSON.stringify({ clearCache: args.clearCache === true ? 'clear' : 'do_not_clear' }),
        },
        { signal: args.signal },
      );
      ensureOk(response, 'createDeploy');
      return parseDeploy(response.body);
    },
    async getDeploy(args) {
      const response = await transport(
        {
          method: 'GET',
          url: `${baseUrl}/services/${args.serviceId}/deploys/${args.deployId}`,
          headers: authHeaders,
        },
        { signal: args.signal },
      );
      ensureOk(response, 'getDeploy');
      return parseDeploy(response.body);
    },
    async checkHealth(args) {
      const response = await transport(
        { method: 'GET', url: args.url, headers: { accept: 'application/json' } },
        { signal: args.signal },
      );
      return { healthy: response.ok, status: response.status };
    },
  };
}
