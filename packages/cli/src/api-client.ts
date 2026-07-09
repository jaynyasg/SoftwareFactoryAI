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
  RunMode,
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
  /** Inline PRD body text (the route reads `body.prdText`). */
  readonly prdText?: string;
  readonly title?: string;
  readonly localFolder?: string;
  readonly githubRepo?: string;
  readonly selectedAdapter?: string;
  readonly modelProfile?: string;
  readonly reasoningEffort?: string;
  readonly requestedWorkerCap?: number;
  readonly reviewMode?: ReviewMode;
  /**
   * Run mode: `plan-only` (default), `research-and-plan`, or
   * `research-plan-and-start`. Omitted = the backend's plan-only default.
   */
  readonly mode?: RunMode;
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

/**
 * Stage-resume outcome attached to an approved review (typed mirror of the
 * server's `StageResumeResult`): which blocked stage the approval resumed,
 * which interventions it resolved, and whether the stage's job was re-queued.
 */
export interface ReviewResumeResult {
  readonly stage: string;
  readonly resolvedInterventions: readonly string[];
  readonly queued: boolean;
  readonly note?: string;
}

export interface ReviewResult {
  readonly runId: string;
  readonly run: RunProjection;
  /** Present when an approval resumed a blocked stage (absent otherwise). */
  readonly resumed?: ReviewResumeResult;
}

/* Execution controls (full-factory U5). Commands enqueue/mutate queue state on
 * the backend and return projected state — the CLI never waits for workers. */

export interface ExecutionCommandInput {
  /** Optimistic-concurrency check; rejected with 409 when stale. */
  readonly expectedVersion?: number;
  readonly reason?: string;
}

export interface RetryRunInput extends ExecutionCommandInput {
  /** Optional ticket focus for the retry (consumed by execution integration). */
  readonly ticketId?: string;
}

/** Compact projected execution state returned by execution commands. */
export interface ExecutionSummary {
  readonly state: string;
  readonly reason?: string;
}

/** Projected queue-job view returned by execution commands. */
export interface QueueJobSummary {
  readonly jobId: string;
  readonly jobKind: string;
  readonly attempt: number;
  readonly status: string;
  readonly reason?: string;
}

export interface ExecutionCommandResult {
  readonly runId: string;
  readonly queued?: boolean;
  readonly alreadyQueued?: boolean;
  readonly paused?: boolean;
  readonly resumed?: boolean;
  readonly execution?: ExecutionSummary;
  readonly job?: QueueJobSummary;
  readonly run?: RunProjection;
}

export interface InterventionSummary {
  readonly interventionId: string;
  readonly runId: string;
  readonly kind: string;
  readonly severity: string;
  readonly blockingStage: string;
  readonly reason: string;
  readonly requiredAction: string;
  readonly status: string;
  readonly resolution?: string;
  /** Ledger sequence the intervention was raised at (FIFO/ordering signal). */
  readonly sequence?: number;
}

export interface ListInterventionsQuery {
  readonly runId?: string;
  readonly kind?: string;
  readonly severity?: string;
  readonly blockingStage?: string;
  readonly open?: boolean;
}

export interface ListInterventionsResult {
  readonly interventions: readonly InterventionSummary[];
  readonly openCount: number;
}

export interface ResolveInterventionInput {
  readonly resolution: string;
  readonly note?: string;
  readonly expectedVersion?: number;
}

export interface ResolveInterventionResult {
  readonly alreadyResolved?: boolean;
  readonly intervention?: InterventionSummary;
}

/** Input for triggering (or retrying) workspace materialization (U4). */
export interface MaterializeWorkspaceInput {
  /** Requested branch for repository checkouts. */
  readonly branch?: string;
  /** Optimistic-concurrency check; rejected with 409 when stale. */
  readonly expectedVersion?: number;
}

/**
 * Workspace materialization result. The `result`/`workspace` shapes are
 * whole-object passthroughs from the worker projection (kept as records so a
 * drifting server payload degrades to unknown fields, not lying types).
 */
export interface MaterializeWorkspaceResult {
  readonly runId: string;
  readonly result?: Record<string, unknown>;
  readonly workspace?: Record<string, unknown>;
  readonly run?: RunProjection;
}

/** Projected workspace state for a run (GET /api/runs/:id/workspace). */
export interface WorkspaceStatusResult {
  readonly runId: string;
  readonly workspace?: Record<string, unknown>;
}

export interface SetupResult {
  readonly operatorToken: { readonly present: boolean };
  readonly sandbox: { readonly status: string };
  readonly adapters: { readonly status: string; readonly detected: readonly string[] };
  readonly deploy: { readonly status: string };
  readonly workspace: { readonly root: string };
  readonly runtime?: {
    readonly mode?: string;
    readonly publicBaseUrl?: string;
    readonly factoryDir?: string;
    readonly operatorTokenSource?: string;
  };
}

export interface ApiClient {
  readonly baseUrl: string;
  /** Absolute URL of a run's read-only event log (returned in CLI output). */
  eventsUrl(runId: string): string;
  createRun(input: CreateRunInput): Promise<CreateRunResult>;
  getRun(runId: string): Promise<RunProjection>;
  getEvents(runId: string, options?: GetEventsOptions): Promise<GetEventsResult>;
  cancelRun(runId: string, input: CancelRunInput): Promise<{ runId: string; run: RunProjection }>;
  review(runId: string, input: ReviewInput): Promise<ReviewResult>;
  /** Materialize (or retry materializing) the run workspace (U4). */
  materializeWorkspace(
    runId: string,
    input?: MaterializeWorkspaceInput,
  ): Promise<MaterializeWorkspaceResult>;
  /** Read the projected workspace state for a run (U4). */
  getWorkspace(runId: string): Promise<WorkspaceStatusResult>;
  getSetup(): Promise<SetupResult>;
  /** Preflight + enqueue execution for a planned run (U5). */
  startRun(runId: string, input?: ExecutionCommandInput): Promise<ExecutionCommandResult>;
  pauseRun(runId: string, input?: ExecutionCommandInput): Promise<ExecutionCommandResult>;
  resumeRun(runId: string, input?: ExecutionCommandInput): Promise<ExecutionCommandResult>;
  retryRun(runId: string, input?: RetryRunInput): Promise<ExecutionCommandResult>;
  rerunGates(runId: string, input?: ExecutionCommandInput): Promise<ExecutionCommandResult>;
  /** Projected execution state: queue job, preflight, open interventions. */
  getExecution(runId: string): Promise<Record<string, unknown>>;
  listInterventions(query?: ListInterventionsQuery): Promise<ListInterventionsResult>;
  resolveIntervention(
    interventionId: string,
    input: ResolveInterventionInput,
  ): Promise<ResolveInterventionResult>;
}

function trimBase(url: string): string {
  return url.endsWith('/') ? url.replace(/\/+$/, '') : url;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/* ----------------------------------------------------------------------------
 * Response-shape extraction. Every method destructures the safe fields it
 * documents from the parsed `Record<string, unknown>` body (the createRun
 * pattern) instead of whole-record `as` casts, so a drifting server payload
 * degrades to absent optional fields rather than lying types.
 * ------------------------------------------------------------------------- */

function optStr(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function optNum(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function toExecutionSummary(value: unknown): ExecutionSummary | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const record = asRecord(value);
  const state = optStr(record.state);
  return state === undefined ? undefined : { state, reason: optStr(record.reason) };
}

function toQueueJobSummary(value: unknown): QueueJobSummary | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const record = asRecord(value);
  const jobId = optStr(record.jobId);
  const jobKind = optStr(record.jobKind);
  const attempt = optNum(record.attempt);
  const status = optStr(record.status);
  if (
    jobId === undefined ||
    jobKind === undefined ||
    attempt === undefined ||
    status === undefined
  ) {
    return undefined;
  }
  return { jobId, jobKind, attempt, status, reason: optStr(record.reason) };
}

function toExecutionCommandResult(
  runId: string,
  body: Record<string, unknown>,
): ExecutionCommandResult {
  return {
    runId: optStr(body.runId) ?? runId,
    queued: optBool(body.queued),
    alreadyQueued: optBool(body.alreadyQueued),
    paused: optBool(body.paused),
    resumed: optBool(body.resumed),
    execution: toExecutionSummary(body.execution),
    job: toQueueJobSummary(body.job),
    run: body.run !== undefined ? (body.run as RunProjection) : undefined,
  };
}

function toInterventionSummary(value: unknown): InterventionSummary | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const record = asRecord(value);
  const interventionId = optStr(record.interventionId);
  const runId = optStr(record.runId);
  const kind = optStr(record.kind);
  const severity = optStr(record.severity);
  const blockingStage = optStr(record.blockingStage);
  const reason = optStr(record.reason);
  const requiredAction = optStr(record.requiredAction);
  const status = optStr(record.status);
  if (
    interventionId === undefined ||
    runId === undefined ||
    kind === undefined ||
    severity === undefined ||
    blockingStage === undefined ||
    reason === undefined ||
    requiredAction === undefined ||
    status === undefined
  ) {
    return undefined;
  }
  return {
    interventionId,
    runId,
    kind,
    severity,
    blockingStage,
    reason,
    requiredAction,
    status,
    resolution: optStr(record.resolution),
    sequence: optNum(record.sequence),
  };
}

function toReviewResume(value: unknown): ReviewResumeResult | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const record = asRecord(value);
  const stage = optStr(record.stage);
  const queued = optBool(record.queued);
  if (stage === undefined || queued === undefined) {
    return undefined;
  }
  const resolvedInterventions = Array.isArray(record.resolvedInterventions)
    ? record.resolvedInterventions.filter((item): item is string => typeof item === 'string')
    : [];
  return { stage, resolvedInterventions, queued, note: optStr(record.note) };
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
        prdText: input.prdText,
        title: input.title,
        localFolder: input.localFolder,
        githubRepo: input.githubRepo,
        selectedAdapter: input.selectedAdapter,
        modelProfile: input.modelProfile,
        reasoningEffort: input.reasoningEffort,
        requestedWorkerCap: input.requestedWorkerCap,
        reviewMode: input.reviewMode,
        mode: input.mode,
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
      return {
        runId: String(body.runId ?? runId),
        run: body.run as RunProjection,
        // Present when an approval resumed a blocked stage (`resumed: null`
        // otherwise) — surfaced so callers can report what the approval did.
        resumed: toReviewResume(body.resumed),
      };
    },
    async materializeWorkspace(runId, input = {}) {
      const body = await mutate(`/api/runs/${encodeURIComponent(runId)}/workspace`, {
        branch: input.branch,
        expectedVersion: input.expectedVersion,
      });
      return {
        runId: String(body.runId ?? runId),
        result: body.result !== undefined ? asRecord(body.result) : undefined,
        workspace: body.workspace !== undefined ? asRecord(body.workspace) : undefined,
        run: body.run !== undefined ? (body.run as RunProjection) : undefined,
      };
    },
    async getWorkspace(runId) {
      const body = await get(`/api/runs/${encodeURIComponent(runId)}/workspace`);
      return {
        runId: String(body.runId ?? runId),
        workspace: body.workspace !== undefined ? asRecord(body.workspace) : undefined,
      };
    },
    async getSetup() {
      const body = await get('/api/setup');
      return body as unknown as SetupResult;
    },
    async startRun(runId, input = {}) {
      const body = await mutate(`/api/runs/${encodeURIComponent(runId)}/start`, {
        expectedVersion: input.expectedVersion,
        reason: input.reason,
      });
      return toExecutionCommandResult(runId, body);
    },
    async pauseRun(runId, input = {}) {
      const body = await mutate(`/api/runs/${encodeURIComponent(runId)}/pause`, {
        expectedVersion: input.expectedVersion,
        reason: input.reason,
      });
      return toExecutionCommandResult(runId, body);
    },
    async resumeRun(runId, input = {}) {
      const body = await mutate(`/api/runs/${encodeURIComponent(runId)}/resume`, {
        expectedVersion: input.expectedVersion,
        reason: input.reason,
      });
      return toExecutionCommandResult(runId, body);
    },
    async retryRun(runId, input = {}) {
      const body = await mutate(`/api/runs/${encodeURIComponent(runId)}/retry`, {
        expectedVersion: input.expectedVersion,
        reason: input.reason,
        ticketId: input.ticketId,
      });
      return toExecutionCommandResult(runId, body);
    },
    async rerunGates(runId, input = {}) {
      const body = await mutate(`/api/runs/${encodeURIComponent(runId)}/gates/rerun`, {
        expectedVersion: input.expectedVersion,
        reason: input.reason,
      });
      return toExecutionCommandResult(runId, body);
    },
    async getExecution(runId) {
      return get(`/api/runs/${encodeURIComponent(runId)}/execution`);
    },
    async listInterventions(query = {}) {
      const params = new URLSearchParams();
      if (query.runId !== undefined) {
        params.set('runId', query.runId);
      }
      if (query.kind !== undefined) {
        params.set('kind', query.kind);
      }
      if (query.severity !== undefined) {
        params.set('severity', query.severity);
      }
      if (query.blockingStage !== undefined) {
        params.set('blockingStage', query.blockingStage);
      }
      if (query.open === true) {
        params.set('open', '1');
      }
      const suffix = params.size > 0 ? `?${params.toString()}` : '';
      const body = await get(`/api/interventions${suffix}`);
      const interventions = (Array.isArray(body.interventions) ? body.interventions : [])
        .map(toInterventionSummary)
        .filter((item): item is InterventionSummary => item !== undefined);
      return { interventions, openCount: optNum(body.openCount) ?? 0 };
    },
    async resolveIntervention(interventionId, input) {
      const body = await mutate(
        `/api/interventions/${encodeURIComponent(interventionId)}/resolve`,
        {
          resolution: input.resolution,
          note: input.note,
          expectedVersion: input.expectedVersion,
        },
      );
      return {
        alreadyResolved: optBool(body.alreadyResolved),
        intervention: toInterventionSummary(body.intervention),
      };
    },
  };
}
