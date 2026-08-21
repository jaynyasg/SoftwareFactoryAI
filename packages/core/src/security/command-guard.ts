/**
 * Command guard for mutating operator actions.
 *
 * `checkCommand` is a PURE, synchronous policy decision. It enforces, for any
 * mutating command:
 *   (a) a valid operator token/session,
 *   (b) a same-origin / allowed-origin request,
 *   (c) a CSRF double-submit token, and
 *   (d) a fresh subject version (optimistic-concurrency / stale-command guard).
 *
 * The guard performs NO side effects. On denial it returns a discriminated
 * result carrying a stable `reason`, a ledger `severity`, the `event` the caller
 * should append (`security.block` for access/forgery denials,
 * `security.command_rejected` for stale commands), and a human message. The
 * caller is responsible for appending that single ledger event and MUST NOT
 * start workers, adapters, deploys, or repo writes when denied.
 *
 * Shared by every mutating route (run create/cancel, review, and later adapter,
 * sandbox, deploy, and repo actions) so the policy lives in exactly one place.
 */
import { constantTimeEqual } from './operator-token';
import type { EventSeverity } from '../events/event-types';

/** Methods that mutate state and therefore require the guard. */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** True when the HTTP method mutates state (and must pass the guard). */
export function isMutatingMethod(method: string): boolean {
  return MUTATING_METHODS.has(method.toUpperCase());
}

/** The stable, exhaustive set of rejection reasons. */
export type CommandRejectionReason =
  | 'missing_token'
  | 'invalid_token'
  | 'origin_not_allowed'
  | 'csrf_failed'
  | 'stale_subject_version';

/** The entity a command targets; `version` drives the stale-command check. */
export interface CommandSubjectRef {
  readonly kind: string;
  readonly id: string;
  /** The subject version the client believes is current. */
  readonly version?: number;
}

/** The request-derived inputs the guard inspects. */
export interface CommandGuardRequest {
  /** HTTP method; the guard treats every call as a mutating command. */
  readonly method: string;
  /** Presented operator token (from `x-operator-token` / `Authorization`). */
  readonly token?: string;
  /** `Origin` header value, if the client sent one. */
  readonly origin?: string;
  /** CSRF double-submit token from the request header. */
  readonly csrfHeader?: string;
  /** The targeted subject, for the stale-version check. */
  readonly subject?: CommandSubjectRef;
}

/** The trusted context the caller supplies (resolved from state + config). */
export interface CommandGuardContext {
  /** Constant-time check of the presented token against the active session. */
  readonly verifyToken: (token: string) => boolean;
  /**
   * Allowed `Origin` values (exact match). A request with no `Origin` (CLI,
   * curl, same-origin server call) is permitted; a present-but-unlisted origin
   * is rejected.
   */
  readonly allowedOrigins: readonly string[];
  /**
   * Expected CSRF token (double-submit). When set, the request must echo it in
   * `csrfHeader`. When omitted, the CSRF check is skipped (e.g. non-browser
   * callers that already passed token + origin checks).
   */
  readonly csrfToken?: string;
  /** Current version of the targeted subject from projected state, if known. */
  readonly currentSubjectVersion?: number;
}

/** A denial decision. Carries everything the caller needs to record it. */
export interface CommandDenied {
  readonly allowed: false;
  readonly reason: CommandRejectionReason;
  readonly severity: EventSeverity;
  /** Which ledger event the caller should append for this denial. */
  readonly event: 'security.block' | 'security.command_rejected';
  /** Human-facing explanation (safe to surface to the operator). */
  readonly message: string;
}

/** The guard result: allow, or a fully-specified denial. */
export type CommandGuardResult = { readonly allowed: true } | CommandDenied;

const ALLOWED: CommandGuardResult = { allowed: true };

function deny(
  reason: CommandRejectionReason,
  severity: EventSeverity,
  event: CommandDenied['event'],
  message: string,
): CommandDenied {
  return { allowed: false, reason, severity, event, message };
}

/**
 * Decide whether a mutating command may proceed. Pure and synchronous: it reads
 * only its arguments and returns a decision. Checks run auth -> origin -> CSRF
 * -> freshness so the most security-relevant failures win.
 */
export function checkCommand(
  request: CommandGuardRequest,
  context: CommandGuardContext,
): CommandGuardResult {
  // (a) operator token / session.
  if (request.token === undefined || request.token.length === 0) {
    return deny('missing_token', 'warn', 'security.block', 'Operator token is required.');
  }
  if (!context.verifyToken(request.token)) {
    return deny('invalid_token', 'error', 'security.block', 'Operator token is invalid.');
  }

  // (b) same-origin / allowed-origin. Absent Origin => non-browser caller: ok.
  if (request.origin !== undefined && request.origin.length > 0) {
    if (!context.allowedOrigins.includes(request.origin)) {
      return deny(
        'origin_not_allowed',
        'error',
        'security.block',
        `Origin ${request.origin} is not allowed.`,
      );
    }
  }

  // (c) CSRF double-submit, when an expected token is configured.
  if (context.csrfToken !== undefined && context.csrfToken.length > 0) {
    if (
      request.csrfHeader === undefined ||
      request.csrfHeader.length === 0 ||
      !constantTimeEqual(context.csrfToken, request.csrfHeader)
    ) {
      return deny('csrf_failed', 'error', 'security.block', 'CSRF token missing or mismatched.');
    }
  }

  // (d) stale-command / optimistic-concurrency check on the subject version.
  if (
    request.subject?.version !== undefined &&
    context.currentSubjectVersion !== undefined &&
    request.subject.version !== context.currentSubjectVersion
  ) {
    return deny(
      'stale_subject_version',
      'warn',
      'security.command_rejected',
      `Command targets stale ${request.subject.kind} version ${request.subject.version}; current is ${context.currentSubjectVersion}.`,
    );
  }

  return ALLOWED;
}
