/**
 * Multi-user auth routes (U3).
 *
 *   POST /api/auth/login          (public)        — username+password → session
 *                                  cookie. Pre-session CSRF: mandatory origin
 *                                  check for browser callers plus a pre-auth
 *                                  double-submit cookie pair.
 *   POST /api/auth/logout         (authenticated) — delete the session record
 *                                  and clear the cookie.
 *   GET  /api/auth/identity       (authenticated) — the caller's identity and
 *                                  (session callers) their per-session CSRF.
 *   POST /api/auth/invite/redeem  (public)        — atomic invite/bootstrap
 *                                  redemption → account + session cookie. One
 *                                  generic failure for every invalid invite
 *                                  (used/revoked/expired/nonexistent are
 *                                  indistinguishable — no oracle).
 *   POST /api/auth/token          (authenticated) — mint/rotate the caller's
 *                                  personal API token; shown exactly once.
 *   GET  /api/auth/invites        (admin)         — invite list with status.
 *   POST /api/auth/invites        (admin)         — issue an invite (optional
 *                                  forUserId = re-invite/password reset).
 *   POST /api/auth/invites/:id/revoke (admin)     — revoke an open invite.
 *   GET  /api/auth/users          (admin)         — user list (no secrets).
 *   POST /api/auth/users/:id/revoke  (admin)      — revoke a user: account +
 *                                  sessions + API tokens die together; the
 *                                  handler also cancels the user's
 *                                  non-terminal runs (G4 cascade, wired fully
 *                                  in U7).
 *
 * Every route 503s cleanly in single-tenant mode (no auth service) — the
 * login surface simply does not exist there.
 */
import { isRealRun, projectRun } from '@software-factory/core';
import type { ApiResponse, RouteContext, RouteDef } from '../app';
import { readCookie } from '../app';
import { deriveClientIp } from '../auth/throttle';
import { asRecord, str } from './parse';

const AUTH_DISABLED: ApiResponse = {
  status: 503,
  body: {
    error: 'auth_disabled',
    message: 'Multi-user auth is not enabled on this server instance.',
  },
};

/** Pre-auth CSRF pair for the public POSTs (login / invite redemption). */
const PREAUTH_COOKIE = 'sf_preauth';

/**
 * Pre-session CSRF: browser callers (Origin present) must present the
 * double-submit pair; the origin itself is validated by comparing against the
 * configured allowed origins. Non-browser callers (no Origin header — CLI,
 * curl) cannot be cross-site-forged and pass without the pair.
 */
function preauthCsrfFailure(ctx: RouteContext): ApiResponse | null {
  const origin = ctx.request.headers['origin'];
  if (origin === undefined || origin.length === 0) {
    return null;
  }
  const allowed = ctx.config.allowedOrigins.includes(origin);
  if (!allowed && !ctx.config.allowSameHostOrigin) {
    return { status: 403, body: { error: 'origin_not_allowed', message: 'Origin not allowed.' } };
  }
  const cookie = readCookie(ctx.request.headers, PREAUTH_COOKIE);
  const header = ctx.request.headers['x-preauth-csrf'];
  if (cookie === undefined || header === undefined || cookie !== header) {
    return {
      status: 403,
      body: {
        error: 'csrf_failed',
        message:
          'Missing or mismatched pre-auth CSRF pair (sf_preauth cookie + x-preauth-csrf header).',
      },
    };
  }
  return null;
}

function clientIp(ctx: RouteContext): string {
  return deriveClientIp(ctx.request.headers, undefined, true);
}

async function login(ctx: RouteContext): Promise<ApiResponse> {
  if (ctx.authService === null) {
    return AUTH_DISABLED;
  }
  const csrf = preauthCsrfFailure(ctx);
  if (csrf !== null) {
    return csrf;
  }
  const body = asRecord(ctx.request.body);
  const username = str(body.username) ?? '';
  const password = str(body.password) ?? '';
  const result = await ctx.authService.login({ username, password, ip: clientIp(ctx) });
  if (!result.ok) {
    const status = result.reason === 'locked_out' ? 429 : 401;
    // One generic message: no username-exists oracle.
    return {
      status,
      body: {
        error: result.reason,
        message:
          result.reason === 'locked_out'
            ? 'Too many attempts — try again later.'
            : 'Invalid username or password.',
      },
    };
  }
  return {
    status: 200,
    headers: { 'set-cookie': ctx.sessionCookie(result.session.sessionToken) },
    body: { identity: result.session.identity, csrfToken: result.session.csrfToken },
  };
}

async function logout(ctx: RouteContext): Promise<ApiResponse> {
  if (ctx.authService === null) {
    return AUTH_DISABLED;
  }
  const denial = await ctx.guardMutation({
    subject: { kind: 'factory', id: 'auth' },
    command: 'auth.logout',
  });
  if (denial !== null) {
    return denial;
  }
  const cookieName = ctx.sessionCookie('probe').split('=')[0];
  const token = readCookie(ctx.request.headers, cookieName);
  if (token !== undefined) {
    await ctx.authService.logout(token);
  }
  return {
    status: 200,
    headers: { 'set-cookie': ctx.sessionCookie(null) },
    body: { ok: true },
  };
}

function identityHandler(ctx: RouteContext): Promise<ApiResponse> {
  if (ctx.authService === null) {
    return Promise.resolve(AUTH_DISABLED);
  }
  // The dispatcher already required authentication for this route.
  return Promise.resolve({ status: 200, body: { identity: ctx.identity } });
}

async function redeemInvite(ctx: RouteContext): Promise<ApiResponse> {
  if (ctx.authService === null) {
    return AUTH_DISABLED;
  }
  const csrf = preauthCsrfFailure(ctx);
  if (csrf !== null) {
    return csrf;
  }
  const body = asRecord(ctx.request.body);
  const result = await ctx.authService.redeemInvite({
    token: str(body.token) ?? '',
    username: str(body.username) ?? '',
    password: str(body.password) ?? '',
    ip: clientIp(ctx),
  });
  if (!result.ok) {
    const status = result.reason === 'locked_out' ? 429 : 400;
    const message =
      result.reason === 'invalid_invite'
        ? 'This invite is no longer valid — ask your admin for a new one.'
        : result.reason === 'username_taken'
          ? 'That username is taken.'
          : result.reason === 'weak_password'
            ? 'Password must be at least 12 characters.'
            : result.reason === 'invalid_username'
              ? 'Usernames are 3-32 characters: letters, digits, dot, dash, underscore.'
              : 'Too many attempts — try again later.';
    return { status, body: { error: result.reason, message } };
  }
  return {
    status: 201,
    headers: { 'set-cookie': ctx.sessionCookie(result.session.sessionToken) },
    body: { identity: result.session.identity, csrfToken: result.session.csrfToken },
  };
}

async function mintToken(ctx: RouteContext): Promise<ApiResponse> {
  if (ctx.authService === null || ctx.identity === null) {
    return AUTH_DISABLED;
  }
  const denial = await ctx.guardMutation({
    subject: { kind: 'factory', id: 'auth' },
    command: 'auth.mint_api_token',
  });
  if (denial !== null) {
    return denial;
  }
  const minted = await ctx.authService.mintApiToken(ctx.identity.userId);
  if (minted === null) {
    return { status: 404, body: { error: 'not_found', message: 'No active account.' } };
  }
  // The ONLY place the full token value ever appears.
  return { status: 201, body: { token: minted.token, shownOnce: true } };
}

async function listInvites(ctx: RouteContext): Promise<ApiResponse> {
  if (ctx.authService === null) {
    return AUTH_DISABLED;
  }
  return { status: 200, body: { invites: await ctx.authService.listInvites() } };
}

async function issueInvite(ctx: RouteContext): Promise<ApiResponse> {
  if (ctx.authService === null || ctx.identity === null) {
    return AUTH_DISABLED;
  }
  const denial = await ctx.guardMutation({
    subject: { kind: 'factory', id: 'auth' },
    command: 'auth.issue_invite',
  });
  if (denial !== null) {
    return denial;
  }
  const body = asRecord(ctx.request.body);
  const invite = await ctx.authService.issueInvite(ctx.identity.userId, str(body.forUserId));
  // The token appears exactly once, for the admin to hand to the invitee.
  return { status: 201, body: { inviteId: invite.inviteId, token: invite.token } };
}

async function revokeInvite(ctx: RouteContext): Promise<ApiResponse> {
  if (ctx.authService === null) {
    return AUTH_DISABLED;
  }
  const denial = await ctx.guardMutation({
    subject: { kind: 'factory', id: 'auth' },
    command: 'auth.revoke_invite',
  });
  if (denial !== null) {
    return denial;
  }
  const revoked = await ctx.authService.revokeInvite(ctx.params.id);
  return revoked
    ? { status: 200, body: { ok: true } }
    : { status: 404, body: { error: 'not_found', message: 'No open invite with that id.' } };
}

async function listUsers(ctx: RouteContext): Promise<ApiResponse> {
  if (ctx.authService === null) {
    return AUTH_DISABLED;
  }
  return { status: 200, body: { users: await ctx.authService.listUsers() } };
}

async function revokeUser(ctx: RouteContext): Promise<ApiResponse> {
  if (ctx.authService === null) {
    return AUTH_DISABLED;
  }
  const denial = await ctx.guardMutation({
    subject: { kind: 'factory', id: 'auth' },
    command: 'auth.revoke_user',
  });
  if (denial !== null) {
    return denial;
  }
  const userId = ctx.params.id;
  const outcome = await ctx.authService.revokeUser(userId);
  if (!outcome.ok) {
    return { status: 404, body: { error: 'not_found', message: 'No active user with that id.' } };
  }
  // G4 cascade: cancel the revoked user's non-terminal runs so nothing keeps
  // executing (and billing) on their behalf. Ownerless legacy runs are
  // admin-owned and unaffected. Full credential cleanup composes in U7.
  const cancelled: string[] = [];
  const runIds = await ctx.reader.listRuns();
  for (const runId of runIds) {
    const events = await ctx.reader.readRun(runId);
    const run = projectRun(events, runId);
    if (!isRealRun(run) || run.ownerId !== userId) {
      continue;
    }
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
      continue;
    }
    await ctx.writer.append({
      runId,
      type: 'run.cancelled',
      actor: { kind: 'operator', id: ctx.identity?.userId ?? 'admin' },
      subject: { kind: 'run', id: runId },
      severity: 'warn',
      idempotencyKey: `${runId}:run.cancelled:revoke-${userId}`,
      payload: { reason: `owner account revoked` },
    });
    cancelled.push(runId);
  }
  if (cancelled.length > 0 && ctx.executionDaemon !== null) {
    await ctx.executionDaemon.cancelRuns(cancelled);
  }
  return {
    status: 200,
    body: {
      ok: true,
      sessionsInvalidated: outcome.sessionsInvalidated,
      apiTokensRevoked: outcome.apiTokensRevoked,
      runsCancelled: cancelled,
    },
  };
}

export function authRoutes(): RouteDef[] {
  return [
    { method: 'POST', pattern: '/api/auth/login', access: 'public', handler: login },
    { method: 'POST', pattern: '/api/auth/logout', access: 'authenticated', handler: logout },
    { method: 'GET', pattern: '/api/auth/identity', access: 'authenticated', handler: identityHandler },
    { method: 'POST', pattern: '/api/auth/invite/redeem', access: 'public', handler: redeemInvite },
    { method: 'POST', pattern: '/api/auth/token', access: 'authenticated', handler: mintToken },
    { method: 'GET', pattern: '/api/auth/invites', access: 'admin', handler: listInvites },
    { method: 'POST', pattern: '/api/auth/invites', access: 'admin', handler: issueInvite },
    { method: 'POST', pattern: '/api/auth/invites/:id/revoke', access: 'admin', handler: revokeInvite },
    { method: 'GET', pattern: '/api/auth/users', access: 'admin', handler: listUsers },
    { method: 'POST', pattern: '/api/auth/users/:id/revoke', access: 'admin', handler: revokeUser },
  ];
}
