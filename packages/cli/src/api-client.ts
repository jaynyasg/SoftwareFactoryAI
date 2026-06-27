/**
 * HTTP client for the local Software Factory backend.
 *
 * Talks to the same loopback API the web UI uses (createApp in
 * @software-factory/web), over plain HTTP. Reads hit the read-only routes (no
 * auth). Mutations attach the operator token (`x-operator-token`) and, when
 * configured, the CSRF token (`x-csrf-token`); cancel/review also send an
 * `expectedVersion` so the command guard's optimistic-concurrency check applies.
 *
 * The CLI is a NON-browser caller, so it deliberately sends NO `Origin` header —
 * the guard treats a no-Origin request with a valid token as the trusted local
 * operator (and the CLI's default standalone backend configures no CSRF token,
 * so the operator token alone authenticates).
 *
 * All non-2xx responses raise a typed `ApiError` carrying the backend's stable
 * `error` code and message, so auth/stale failures surface clearly and never
 * masquerade as success.
 */
import type {
  CallerFamily,
  FactoryEvent,
  ReviewDecision,
  ReviewMode,
  RiskTier,
  RunProjection,
} from '@software-factory/core';

/** The subset of `fetch` this client relies on (so tests can inject a mock). */
export type FetchLike = typeof fetch;

/** Bounded per-request timeout so a hung backend never blocks the CLI forever. */
const REQUEST_TIMEOUT_MS = 30_000;

/** A typed transport/protocol error. `code` is the backend's stable `error`. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** True for auth/forgery denials (token/origin/CSRF). */
  get isAuthFailure(): boolean {
    return this.status === 401 || this.status === 403;
  }

  /** True for a stale-command (optimistic-concurrency) rejection. */
  get isStale(): boolean {
    return this.status === 409;
  }
}

export interface ApiClientOptions {
  /** Base URL of the backend, e.g. `http://127.0.0.1:3000`. */
  readonly baseUrl: string;
  /** Operator token for mutating routes (omit for read-only usage). */
  readonly operatorToken?: string;
  /** CSRF token, when the target server configures one (browser-style servers). */
  readonly csrfToken?: string;
  /** Injectable fetch (defaults to the global). */
  readonly fetchImpl?: FetchLike;
}

export interface CreateRunInput {
  readonly prompt?: string;
  readonly prdRef?: string;
  readonly title?: string;
  readonly localFolder?: string;
  readonly githubRepo?: string;
  readonly selectedAdapter?: string;
  readonly modelProfile?: string;
  readonly reasoningEffort?: string;
  readonly requestedWorkerCap?: number;
  readonly reviewMode?: ReviewMode;
  /** Forwarded so nested-agent metadata can be recorded against this run. */
  readonly callerFamily?: CallerFamily;
  /** Idempotency key so a retried create returns the original run. */
  readonly idempotencyKey?: string;
}

export interface CreateRunResult {
  readonly runId: string;
  readonly deduplicated?: boolean;
  readonly run: RunProjection;
}

export interface GetEventsOptions {
  /** Only return events with `sequence` strictly greater than this (resume). */
  readonly sinceSequence?: number;
}

export interface GetEventsResult {
  readonly runId: string;
  readonly events: readonly FactoryEvent[];
}

export interface CancelRunInput {
  readonly expectedVersion: number;
  readonly reason?: string;
}

export interface ReviewInput {
  readonly decision: ReviewDecision;
  readonly riskTier: RiskTier;
  readonly expectedVersion: number;
  readonly rationale?: string;
  readonly mode?: ReviewMode;
}

export interface SetupResult {
  readonly operatorToken: { readonly present: boolean };
  readonly sandbox: { readonly status: string };
  readonly adapters: { readonly status: string; readonly detected: readonly string[] };
  readonly deploy: { readonly status: string };
  readonly workspace: { readonly root: string };
}

export interface ApiClient {
  readonly baseUrl: string;
  /** Absolute URL of a run's read-only event log (returned in CLI output). */
  eventsUrl(runId: string): string;
  createRun(input: CreateRunInput): Promise<CreateRunResult>;
  getRun(runId: string): Promise<RunProjection>;
  getEvents(runId: string, options?: GetEventsOptions): Promise<GetEventsResult>;
  cancelRun(runId: string, input: CancelRunInput): Promise<{ runId: string; run: RunProjection }>;
  review(runId: string, input: ReviewInput): Promise<{ runId: string; run: RunProjection }>;
  getSetup(): Promise<SetupResult>;
}

function trimBase(url: string): string {
  return url.endsWith('/') ? url.replace(/\/+$/, '') : url;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const baseUrl = trimBase(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('No fetch implementation available; pass options.fetchImpl.');
  }

  function url(path: string): string {
    return `${baseUrl}${path}`;
  }

  function mutationHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (options.operatorToken !== undefined && options.operatorToken.length > 0) {
      headers['x-operator-token'] = options.operatorToken;
    }
    if (options.csrfToken !== undefined && options.csrfToken.length > 0) {
      headers['x-csrf-token'] = options.csrfToken;
    }
    return headers;
  }

  async function parse(res: Response): Promise<Record<string, unknown>> {
    try {
      return asRecord(await res.json());
    } catch {
      return {};
    }
  }

  async function get(path: string): Promise<Record<string, unknown>> {
    const res = await fetchImpl(url(path), {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = await parse(res);
    if (!res.ok) {
      throw new ApiError(
        res.status,
        typeof body.error === 'string' ? body.error : 'request_failed',
        typeof body.message === 'string' ? body.message : `GET ${path} failed (${res.status}).`,
      );
    }
    return body;
  }

  async function mutate(
    path: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const res = await fetchImpl(url(path), {
      method: 'POST',
      headers: mutationHeaders(),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = await parse(res);
    if (!res.ok) {
      throw new ApiError(
        res.status,
        typeof body.error === 'string' ? body.error : 'request_failed',
        typeof body.message === 'string' ? body.message : `POST ${path} failed (${res.status}).`,
      );
    }
    return body;
  }

  return {
    baseUrl,
    eventsUrl(runId) {
      return url(`/api/runs/${encodeURIComponent(runId)}/events`);
    },
    async createRun(input) {
      const body = await mutate('/api/runs', {
        prompt: input.prompt,
        prdRef: input.prdRef,
        title: input.title,
        localFolder: input.localFolder,
        githubRepo: input.githubRepo,
        selectedAdapter: input.selectedAdapter,
        modelProfile: input.modelProfile,
        reasoningEffort: input.reasoningEffort,
        requestedWorkerCap: input.requestedWorkerCap,
        reviewMode: input.reviewMode,
        callerFamily: input.callerFamily,
        idempotencyKey: input.idempotencyKey,
      });
      return {
        runId: String(body.runId),
        deduplicated: body.deduplicated === true,
        run: body.run as RunProjection,
      };
    },
    async getRun(runId) {
      const body = await get(`/api/runs/${encodeURIComponent(runId)}`);
      return body.run as RunProjection;
    },
    async getEvents(runId, opts = {}) {
      const body = await get(`/api/runs/${encodeURIComponent(runId)}/events`);
      const all = (body.events as FactoryEvent[] | undefined) ?? [];
      const since = opts.sinceSequence ?? 0;
      const events = since > 0 ? all.filter((event) => event.sequence > since) : all;
      return { runId: String(body.runId ?? runId), events };
    },
    async cancelRun(runId, input) {
      const body = await mutate(`/api/runs/${encodeURIComponent(runId)}/cancel`, {
        expectedVersion: input.expectedVersion,
        reason: input.reason,
      });
      return { runId: String(body.runId ?? runId), run: body.run as RunProjection };
    },
    async review(runId, input) {
      const body = await mutate(`/api/runs/${encodeURIComponent(runId)}/review`, {
        decision: input.decision,
        riskTier: input.riskTier,
        expectedVersion: input.expectedVersion,
        rationale: input.rationale,
        mode: input.mode,
      });
      return { runId: String(body.runId ?? runId), run: body.run as RunProjection };
    },
    async getSetup() {
      const body = await get('/api/setup');
      return body as unknown as SetupResult;
    },
  };
}
