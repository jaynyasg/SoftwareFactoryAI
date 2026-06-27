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
import type { ReviewDecision, ReviewMode, RiskTier, RunProjection } from '@software-factory/core';
import type { RunAggregate } from './types';
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
    'x-operator-token': session.operatorToken,
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
  readonly title?: string;
  readonly requestedWorkerCap?: number;
  readonly reviewMode?: ReviewMode;
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

export interface SubmitReviewResult {
  readonly decision: ReviewDecision;
  readonly riskTier: RiskTier;
  readonly requiredApprovals: number;
  readonly run: RunProjection;
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

/** Poll the projected run view, resuming the ledger from `afterSequence`. */
export async function fetchAggregate(runId: string, afterSequence: number): Promise<RunAggregate> {
  const res = await fetch(
    `/data/runs/${encodeURIComponent(runId)}?after=${encodeURIComponent(String(afterSequence))}`,
    { headers: { accept: 'application/json' }, cache: 'no-store' },
  );
  if (!res.ok) {
    throw new Error(`run_fetch_failed:${res.status}`);
  }
  return (await res.json()) as RunAggregate;
}
