/**
 * Browser API client for the local factory.
 *
 * Reads go to the read-only routes (no token). Mutations attach the loopback
 * `x-operator-token` + `x-csrf-token` and an `expectedVersion` (the run's
 * projected `lastSequence`) so the command guard's auth/origin/CSRF/stale checks
 * are all satisfied for the local operator — and a stale command surfaces as a
 * 409 the caller can recover from. The browser supplies the `Origin` header
 * automatically; tokens therefore never leave loopback.
 */
import type {
  EventSeverity,
  InterventionKind,
  ReviewDecision,
  ReviewMode,
  RiskTier,
  RunProjection,
} from '@software-factory/core';
import type {
  ExecutionOverview,
  InterventionItem,
  InterventionQueueSnapshot,
  RunAggregate,
} from './types';
import { parseExecutionOverview } from './execution-overview';
import type { LocalSession } from './session';

export type { RunAggregate } from './types';

/** Discriminated result so callers can branch on stale/guard failures explicitly. */
export type MutationResult<T> =
  | { readonly ok: true; readonly status: number; readonly data: T }
  | {
      readonly ok: false;
      readonly status: number;
      readonly error: string;
      readonly message?: string;
    };

function mutationHeaders(session: LocalSession): HeadersInit {
  return {
    'content-type': 'application/json',
    // Single-tenant: the loopback operator token. Multi-user: ABSENT — the
    // HttpOnly session cookie (sent automatically same-origin) authenticates.
    ...(session.operatorToken !== undefined
      ? { 'x-operator-token': session.operatorToken }
      : {}),
    'x-csrf-token': session.csrfToken,
  };
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Multi-user U9: an expired/revoked session answers 401 `unauthenticated`.
 * Send the browser to the login page carrying a return-to, so the user lands
 * back where they were. Single-tenant auth failures use OTHER error codes
 * (`invalid_token` etc.) and never trigger this.
 */
function redirectToLoginOnExpiredSession(status: number, error: unknown): void {
  if (status === 401 && error === 'unauthenticated' && typeof window !== 'undefined') {
    const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.assign(`/login?returnTo=${returnTo}`);
  }
}

async function mutate<T>(
  url: string,
  session: LocalSession,
  body: Record<string, unknown>,
): Promise<MutationResult<T>> {
  const res = await fetch(url, {
    method: 'POST',
    headers: mutationHeaders(session),
    body: JSON.stringify(body),
  });
  const json = await readJson(res);
  if (res.ok) {
    return { ok: true, status: res.status, data: json as T };
  }
  redirectToLoginOnExpiredSession(res.status, json.error);
  return {
    ok: false,
    status: res.status,
    error: typeof json.error === 'string' ? json.error : 'request_failed',
    message: typeof json.message === 'string' ? json.message : undefined,
  };
}

export interface StartRunInput {
  readonly prompt?: string;
  readonly prdRef?: string;
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
   * Run mode. The Factory Floor sends `plan-and-start` so one "Start run"
   * click plans AND begins execution; omitted = the server's plan-only default.
   */
  readonly mode?: 'plan-only' | 'plan-and-start' | 'research-and-plan' | 'research-plan-and-start';
}

export interface StartRunResult {
  readonly runId: string;
  readonly run: RunProjection;
}

export function startRun(
  session: LocalSession,
  input: StartRunInput,
): Promise<MutationResult<StartRunResult>> {
  return mutate<StartRunResult>('/api/runs', session, { ...input });
}

export function cancelRun(
  session: LocalSession,
  runId: string,
  expectedVersion: number,
  reason?: string,
): Promise<MutationResult<{ runId: string; run: RunProjection }>> {
  return mutate(`/api/runs/${encodeURIComponent(runId)}/cancel`, session, {
    expectedVersion,
    reason,
  });
}

export interface SubmitReviewInput {
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
  readonly stage: 'gates' | 'execution';
  readonly resolvedInterventions: readonly string[];
  readonly queued: boolean;
  /** True when the re-queued job waits behind the factory drain gate. */
  readonly held?: boolean;
  readonly note?: string;
}

export interface SubmitReviewResult {
  readonly decision: ReviewDecision;
  readonly riskTier: RiskTier;
  readonly requiredApprovals: number;
  readonly run: RunProjection;
  /** `null` unless an approval resumed a blocked stage (server-computed). */
  readonly resumed?: ReviewResumeResult | null;
}

export function submitReview(
  session: LocalSession,
  runId: string,
  input: SubmitReviewInput,
): Promise<MutationResult<SubmitReviewResult>> {
  return mutate<SubmitReviewResult>(`/api/runs/${encodeURIComponent(runId)}/review`, session, {
    ...input,
  });
}

/* ----------------------------------------------------------------------------
 * Execution controls (U5 command surface; U9 operator UI)
 *
 * These commands are idempotent and state-checked SERVER-side (duplicate
 * starts converge on the existing queue job; pause/resume validate the
 * projected execution state), so they deliberately omit `expectedVersion` —
 * on a live run every worker event bumps the version and a stale check would
 * reject nearly every honest click. Cancel keeps its version check because it
 * is destructive.
 * ------------------------------------------------------------------------- */

/** Response shape shared by the execution command routes. */
export interface ExecutionCommandResult {
  readonly runId?: string;
  readonly queued?: boolean;
  readonly alreadyQueued?: boolean;
  /** True when the enqueue landed while the factory drain gate is engaged. */
  readonly held?: boolean;
  readonly paused?: boolean;
  readonly alreadyPaused?: boolean;
  readonly resumed?: boolean;
  readonly execution?: { readonly state: string; readonly reason?: string };
  readonly run?: RunProjection;
}

export function startExecution(
  session: LocalSession,
  runId: string,
  reason?: string,
): Promise<MutationResult<ExecutionCommandResult>> {
  return mutate(`/api/runs/${encodeURIComponent(runId)}/start`, session, { reason });
}

export function pauseExecution(
  session: LocalSession,
  runId: string,
  reason?: string,
): Promise<MutationResult<ExecutionCommandResult>> {
  return mutate(`/api/runs/${encodeURIComponent(runId)}/pause`, session, { reason });
}

export function resumeExecution(
  session: LocalSession,
  runId: string,
  reason?: string,
): Promise<MutationResult<ExecutionCommandResult>> {
  return mutate(`/api/runs/${encodeURIComponent(runId)}/resume`, session, { reason });
}

export function retryExecution(
  session: LocalSession,
  runId: string,
  options: { readonly reason?: string; readonly ticketId?: string } = {},
): Promise<MutationResult<ExecutionCommandResult>> {
  return mutate(`/api/runs/${encodeURIComponent(runId)}/retry`, session, { ...options });
}

export function rerunGates(
  session: LocalSession,
  runId: string,
  reason?: string,
): Promise<MutationResult<ExecutionCommandResult>> {
  return mutate(`/api/runs/${encodeURIComponent(runId)}/gates/rerun`, session, { reason });
}

/**
 * Mid-run settings override: records `run.settings_overridden` so every
 * not-yet-executed ticket picks up the new model/effort on the next
 * execution attempt. Already-executed tickets keep their recorded evidence.
 */
export function overrideRunSettings(
  session: LocalSession,
  runId: string,
  input: {
    readonly selectedAdapter?: string;
    readonly modelProfile?: string;
    readonly reasoningEffort?: string;
    readonly reason?: string;
  },
): Promise<MutationResult<{ runId: string; run: RunProjection }>> {
  return mutate(`/api/runs/${encodeURIComponent(runId)}/settings`, session, { ...input });
}

/** The publish result surfaced by the completion report's GitHub action. */
export interface PublishRunResult {
  readonly runId: string;
  readonly repo: string;
  readonly result: {
    readonly pushed: boolean;
    readonly commit?: string;
    readonly branch: string;
    readonly noChanges: boolean;
    readonly note?: string;
  };
}

/**
 * Publish a completed run's repo-checkout deliverable to its GitHub remote
 * (commit + push; recorded on the ledger as `workspace.published`).
 */
export function publishRunWorkspace(
  session: LocalSession,
  runId: string,
): Promise<MutationResult<PublishRunResult>> {
  return mutate(`/api/runs/${encodeURIComponent(runId)}/publish`, session, {});
}

/**
 * Trigger (or retry) workspace materialization for a run (U4). Converges on
 * retry server-side; the projected workspace/run in the response reflect the
 * outcome, so callers just reload the aggregate.
 */
export function materializeRunWorkspace(
  session: LocalSession,
  runId: string,
  options: { readonly branch?: string } = {},
): Promise<MutationResult<unknown>> {
  return mutate(`/api/runs/${encodeURIComponent(runId)}/workspace`, session, { ...options });
}

/* ----------------------------------------------------------------------------
 * Factory-wide execution controls (drain gate + cancel-all)
 *
 * The daemon boots HELD: nothing runs automatically when the factory opens.
 * Resume releases the gate for this server process; hold re-engages it; and
 * cancel-all cancels every cancellable run in one guarded command.
 * ------------------------------------------------------------------------- */

/** Poll the factory-wide execution state (read-only, no token). */
export async function fetchExecutionOverview(): Promise<ExecutionOverview> {
  const res = await fetch('/api/execution', {
    headers: { accept: 'application/json' },
    cache: 'no-store',
  });
  const json = await readJson(res);
  if (!res.ok) {
    redirectToLoginOnExpiredSession(res.status, json.error);
    throw new Error(`execution_fetch_failed:${res.status}`);
  }
  return parseExecutionOverview(json);
}

/** Release the drain gate so queued work starts (POST /api/execution/resume). */
export function resumeFactoryExecution(session: LocalSession): Promise<
  MutationResult<{
    resumed?: boolean;
    alreadyActive?: boolean;
    held?: boolean;
    /** False means the gate released but the daemon loop is NOT draining. */
    running?: boolean;
  }>
> {
  return mutate('/api/execution/resume', session, {});
}

/** Re-engage the drain gate: stop starting new work (POST /api/execution/hold). */
export function holdFactoryExecution(
  session: LocalSession,
): Promise<MutationResult<{ held?: boolean; alreadyHeld?: boolean; running?: boolean }>> {
  return mutate('/api/execution/hold', session, {});
}

/** Outcome lists from the guarded cancel-all command. */
export interface CancelAllRunsResult {
  readonly cancelled: readonly string[];
  readonly alreadyCancelled: readonly string[];
  readonly skippedTerminal: readonly string[];
  readonly cancelledCount: number;
  /** Per-run failures, present only when part of the batch could not cancel. */
  readonly errors?: readonly { readonly runId: string; readonly message: string }[];
}

/** Cancel every cancellable run (POST /api/runs/cancel-all). */
export function cancelAllRuns(
  session: LocalSession,
  reason?: string,
): Promise<MutationResult<CancelAllRunsResult>> {
  return mutate('/api/runs/cancel-all', session, { reason });
}

/** Outcome lists from the guarded, DESTRUCTIVE clear-all command. */
export interface ClearAllRunsResult {
  /** Run ids whose ledgers were permanently deleted. */
  readonly cleared: readonly string[];
  readonly clearedCount: number;
  /** Run ids the cancel phase cancelled before deletion. */
  readonly cancelled: readonly string[];
  /** Runs still non-terminal after the cancel phase — kept, never deleted. */
  readonly skipped: readonly { readonly runId: string; readonly status: string }[];
  readonly errors?: readonly { readonly runId: string; readonly message: string }[];
}

/**
 * Clear everything (POST /api/runs/clear-all): cancel every cancellable run,
 * then permanently delete every terminal run's ledger. Irreversible.
 */
export function clearAllRuns(
  session: LocalSession,
  reason?: string,
): Promise<MutationResult<ClearAllRunsResult>> {
  return mutate('/api/runs/clear-all', session, { reason });
}

/* ----------------------------------------------------------------------------
 * Local filesystem browsing (Run control folder picker)
 * ------------------------------------------------------------------------- */

/** One browsable directory entry on the operator's machine. */
export interface FolderBrowseEntry {
  readonly name: string;
  readonly path: string;
  /** Whether a run may bind this folder under the workspace boundary (U4). */
  readonly withinBoundary: boolean;
}

/** A directory listing from the local-first server's filesystem. */
export interface FolderBrowseResult {
  /** The resolved absolute path that was listed. */
  readonly path: string;
  /** Parent directory, or null at a filesystem root. */
  readonly parent: string | null;
  readonly withinBoundary: boolean;
  readonly boundaryRoot: string | null;
  readonly approvedFolders: readonly string[];
  readonly dirs: readonly FolderBrowseEntry[];
  /** Filesystem roots (drive letters on Windows, `/` elsewhere). */
  readonly roots: readonly string[];
}

/**
 * Browse the operator machine's directories (POST /api/fs/browse). The web
 * `showDirectoryPicker()` never reveals absolute paths, so the folder picker
 * browses through the local-first server instead. Omit `path` to start at
 * the workspace boundary root.
 */
export function browseLocalFolders(
  session: LocalSession,
  path?: string,
): Promise<MutationResult<FolderBrowseResult>> {
  return mutate('/api/fs/browse', session, { path });
}

/* ----------------------------------------------------------------------------
 * Operator intervention queue (X4)
 * ------------------------------------------------------------------------- */

/**
 * Item-level shape check for one wire intervention: every field the UI renders
 * is validated structurally; malformed rows are dropped instead of rendering
 * `undefined` into the queue. `kind`/`severity` are validated as strings and
 * then narrowed — the browser bundle must not import core's runtime member
 * lists, and an unrecognized-but-string value degrades to a labeled badge
 * rather than a dropped intervention.
 */
function toInterventionItem(value: unknown): InterventionItem | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const {
    interventionId,
    runId,
    kind,
    severity,
    blockingStage,
    reason,
    requiredAction,
    raisedAt,
    sequence,
    status,
  } = record;
  if (
    typeof interventionId !== 'string' ||
    typeof runId !== 'string' ||
    typeof kind !== 'string' ||
    typeof severity !== 'string' ||
    typeof blockingStage !== 'string' ||
    typeof reason !== 'string' ||
    typeof requiredAction !== 'string' ||
    typeof raisedAt !== 'number' ||
    typeof sequence !== 'number' ||
    (status !== 'open' && status !== 'resolved')
  ) {
    return null;
  }
  return {
    interventionId,
    runId,
    ticketId: typeof record.ticketId === 'string' ? record.ticketId : undefined,
    kind: kind as InterventionKind,
    severity: severity as EventSeverity,
    blockingStage,
    reason,
    requiredAction,
    raisedAt,
    sequence,
    status,
    resolution: typeof record.resolution === 'string' ? record.resolution : undefined,
    resolutionNote: typeof record.resolutionNote === 'string' ? record.resolutionNote : undefined,
    resolvedAt: typeof record.resolvedAt === 'number' ? record.resolvedAt : undefined,
  };
}

/** Poll the cross-run operator intervention queue (read-only, no token). */
export async function fetchInterventions(): Promise<InterventionQueueSnapshot> {
  const res = await fetch('/api/interventions', {
    headers: { accept: 'application/json' },
    cache: 'no-store',
  });
  if (!res.ok) {
    redirectToLoginOnExpiredSession(res.status, (await readJson(res)).error);
    throw new Error(`interventions_fetch_failed:${res.status}`);
  }
  const body = await readJson(res);
  const interventions = (Array.isArray(body.interventions) ? body.interventions : [])
    .map(toInterventionItem)
    .filter((item): item is InterventionItem => item !== null);
  return {
    interventions,
    openCount: typeof body.openCount === 'number' ? body.openCount : 0,
  };
}

export function resolveInterventionItem(
  session: LocalSession,
  interventionId: string,
  input: { readonly resolution: string; readonly note?: string },
): Promise<MutationResult<{ alreadyResolved: boolean; intervention: InterventionItem }>> {
  return mutate(`/api/interventions/${encodeURIComponent(interventionId)}/resolve`, session, {
    ...input,
  });
}

/** Poll the projected run view, resuming the ledger from `afterSequence`. */
export async function fetchAggregate(runId: string, afterSequence: number): Promise<RunAggregate> {
  const res = await fetch(
    `/data/runs/${encodeURIComponent(runId)}?after=${encodeURIComponent(String(afterSequence))}`,
    { headers: { accept: 'application/json' }, cache: 'no-store' },
  );
  if (!res.ok) {
    redirectToLoginOnExpiredSession(res.status, (await readJson(res)).error);
    throw new Error(`run_fetch_failed:${res.status}`);
  }
  return (await res.json()) as RunAggregate;
}

/* ----------------------------------------------------------------------------
 * Per-user credentials, API tokens, and admin surfaces (multi-user U10)
 * ------------------------------------------------------------------------- */

/** Presence-only row for one credential slot (values never reach the client). */
export interface CredentialPresenceItem {
  readonly kind: string;
  readonly present: boolean;
  readonly updatedAt?: number;
  readonly validatedAt?: number;
}

/** Live probe outcome returned by a save (G17 distinguishes rate limits). */
export interface CredentialProbeInfo {
  readonly status: 'valid' | 'valid_rate_limited' | 'invalid' | 'unverifiable';
  readonly detail?: string;
}

export async function fetchCredentials(): Promise<readonly CredentialPresenceItem[]> {
  const res = await fetch('/api/credentials', {
    headers: { accept: 'application/json' },
    cache: 'no-store',
  });
  const body = await readJson(res);
  if (!res.ok) {
    redirectToLoginOnExpiredSession(res.status, body.error);
    throw new Error(`credentials_fetch_failed:${res.status}`);
  }
  return (body.credentials as CredentialPresenceItem[]) ?? [];
}

export interface SaveCredentialResult {
  readonly credentials: readonly CredentialPresenceItem[];
  readonly probe?: CredentialProbeInfo;
  readonly message?: string;
}

export function saveCredential(
  session: LocalSession,
  kind: string,
  value: string,
): Promise<MutationResult<SaveCredentialResult>> {
  return mutate(`/api/credentials/${encodeURIComponent(kind)}`, session, { value });
}

export interface DeleteCredentialConfirmation {
  readonly error: 'confirm_required';
  readonly activeRuns: readonly { runId: string; title?: string; status: string }[];
}

export function deleteCredential(
  session: LocalSession,
  kind: string,
  confirm = false,
): Promise<MutationResult<{ credentials: readonly CredentialPresenceItem[] }>> {
  return mutate(`/api/credentials/${encodeURIComponent(kind)}/delete`, session, { confirm });
}

/** Mint (or rotate) the caller's personal API token — value shown ONCE. */
export function mintApiToken(
  session: LocalSession,
): Promise<MutationResult<{ token: string; shownOnce: boolean }>> {
  return mutate('/api/auth/token', session, {});
}

export interface AdminInviteItem {
  readonly inviteId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly forUserId?: string;
  readonly status: 'open' | 'redeemed' | 'revoked' | 'expired';
}

export async function fetchInvites(): Promise<readonly AdminInviteItem[]> {
  const res = await fetch('/api/auth/invites', {
    headers: { accept: 'application/json' },
    cache: 'no-store',
  });
  const body = await readJson(res);
  if (!res.ok) {
    redirectToLoginOnExpiredSession(res.status, body.error);
    throw new Error(`invites_fetch_failed:${res.status}`);
  }
  return (body.invites as AdminInviteItem[]) ?? [];
}

/** Issue an invite; the TOKEN appears exactly once for the admin to hand out. */
export function createInvite(
  session: LocalSession,
  forUserId?: string,
): Promise<MutationResult<{ inviteId: string; token: string }>> {
  return mutate('/api/auth/invites', session, { forUserId });
}

export function revokeInvite(
  session: LocalSession,
  inviteId: string,
): Promise<MutationResult<{ ok: boolean }>> {
  return mutate(`/api/auth/invites/${encodeURIComponent(inviteId)}/revoke`, session, {});
}

export interface AdminUserItem {
  readonly userId: string;
  readonly username: string;
  readonly role: 'admin' | 'user';
  readonly createdAt: number;
  readonly revoked: boolean;
  readonly hasApiToken: boolean;
}

export async function fetchUsers(): Promise<readonly AdminUserItem[]> {
  const res = await fetch('/api/auth/users', {
    headers: { accept: 'application/json' },
    cache: 'no-store',
  });
  const body = await readJson(res);
  if (!res.ok) {
    redirectToLoginOnExpiredSession(res.status, body.error);
    throw new Error(`users_fetch_failed:${res.status}`);
  }
  return (body.users as AdminUserItem[]) ?? [];
}

export interface RevokeUserResult {
  readonly ok: boolean;
  readonly sessionsInvalidated: number;
  readonly apiTokensRevoked: number;
  readonly runsCancelled: readonly string[];
}

export function revokeUser(
  session: LocalSession,
  userId: string,
): Promise<MutationResult<RevokeUserResult>> {
  return mutate(`/api/auth/users/${encodeURIComponent(userId)}/revoke`, session, {});
}

/** The caller's run list (admins see all) — used to NAME runs in confirmations. */
export async function fetchRunsList(): Promise<readonly RunProjection[]> {
  const res = await fetch('/api/runs', { headers: { accept: 'application/json' }, cache: 'no-store' });
  const body = await readJson(res);
  if (!res.ok) {
    redirectToLoginOnExpiredSession(res.status, body.error);
    throw new Error(`runs_fetch_failed:${res.status}`);
  }
  return (body.runs as RunProjection[]) ?? [];
}
