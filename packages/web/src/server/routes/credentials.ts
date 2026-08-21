/**
 * Per-user credential routes (multi-user U10).
 *
 *   GET  /api/credentials              (authenticated) — the CALLER's presence
 *        rows (present / updatedAt / validatedAt). Values NEVER appear (E5).
 *   POST /api/credentials/:kind        (authenticated, guarded) — validate the
 *        pasted value with a live probe, then save it encrypted. Invalid
 *        credentials are rejected with per-kind mint instructions; a
 *        usage-limited-but-valid credential saves as VALID with the honest
 *        "currently rate-limited" note (G17); an unverifiable probe (CLI
 *        missing, network down) still saves — presence-only, unvalidated —
 *        because preflight re-checks before any run.
 *   POST /api/credentials/:kind/delete (authenticated, guarded) — delete one
 *        slot. When the caller has non-terminal runs the response first asks
 *        for confirmation NAMING those runs (G11); a confirmed delete removes
 *        the slot and subsequent spawns block per R14.
 *
 * Every route 503s cleanly when no credential vault is configured (single-
 * tenant instances have no per-user credentials).
 */
import { isCredentialKind, isRealRun, projectRun } from '@software-factory/core';
import type { CredentialKind, CredentialPresence } from '@software-factory/core';
import type { ApiResponse, RouteContext, RouteDef } from '../app';
import { asRecord, str } from './parse';

/** Max pasted token size (plenty for every API key/token format). */
const MAX_TOKEN_BYTES = 4 * 1024;
/** Max codex auth.json upload (the real file is ~1-2KB). */
const MAX_AUTH_JSON_BYTES = 64 * 1024;

/** Live probe outcome for one credential value (G17 distinguishes limits). */
export type CredentialProbeOutcome =
  | { readonly status: 'valid'; readonly detail?: string }
  | { readonly status: 'valid_rate_limited'; readonly detail?: string }
  | { readonly status: 'invalid'; readonly detail?: string }
  | { readonly status: 'unverifiable'; readonly detail?: string };

/** Probes one (kind, value) WITHOUT persisting anything. Injectable seam. */
export type CredentialProber = (
  kind: CredentialKind,
  value: string,
) => Promise<CredentialProbeOutcome>;

/** Per-kind mint instructions surfaced with an INVALID rejection. */
const MINT_INSTRUCTIONS: Readonly<Record<CredentialKind, string>> = {
  claude_oauth_token:
    'Mint a long-lived token on a machine where the Claude CLI is signed in: run `claude setup-token` and paste the sk-ant-oat… value here.',
  anthropic_api_key:
    'Create an API key in the Anthropic Console (console.anthropic.com → API keys) and paste the sk-ant-api… value here.',
  openai_api_key:
    'Create an API key at platform.openai.com → API keys and paste the sk-… value here.',
  codex_auth_json:
    'On a machine where `codex login` succeeded, upload the file at ~/.codex/auth.json (it holds your ChatGPT-plan session).',
  github_token:
    'Create a fine-grained personal access token (github.com → Settings → Developer settings) scoped to the repositories the factory may read/write, with Contents read/write.',
  render_api_key: 'Create an API key at dashboard.render.com → Account Settings → API Keys.',
  vercel_token: 'Create a token at vercel.com → Account Settings → Tokens.',
};

const VAULT_UNAVAILABLE: ApiResponse = {
  status: 503,
  body: {
    error: 'credentials_unavailable',
    message: 'Per-user credentials are not enabled on this server instance.',
  },
};

const MASTER_KEY_UNREADABLE: ApiResponse = {
  status: 503,
  body: {
    error: 'master_key_unreadable',
    message:
      'The credential vault cannot be opened (SF_MASTER_KEY problem). ADMIN action required; your login still works.',
  },
};

function presenceBody(rows: readonly CredentialPresence[]): Record<string, unknown> {
  return { credentials: rows };
}

async function listCredentials(ctx: RouteContext): Promise<ApiResponse> {
  if (ctx.credentialVault === null || ctx.identity === null || !ctx.multiUser) {
    return VAULT_UNAVAILABLE;
  }
  const rows = await ctx.credentialVault.getPresence(ctx.identity.userId);
  return { status: 200, body: presenceBody(rows) };
}

/** Size + shape validation BEFORE any probe or write. */
function validateValueShape(kind: CredentialKind, value: string): string | null {
  if (value.trim().length === 0) {
    return 'Provide a non-empty value.';
  }
  if (kind === 'codex_auth_json') {
    if (Buffer.byteLength(value, 'utf8') > MAX_AUTH_JSON_BYTES) {
      return 'auth.json is larger than 64KB — that is not a codex auth file. Upload ~/.codex/auth.json.';
    }
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed !== 'object' || parsed === null) {
        return 'auth.json must be a JSON object. Upload ~/.codex/auth.json unmodified.';
      }
    } catch {
      return 'That file is not valid JSON. Upload ~/.codex/auth.json unmodified.';
    }
    return null;
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_TOKEN_BYTES) {
    return 'That value is too large to be a credential token.';
  }
  return null;
}

async function saveCredential(ctx: RouteContext): Promise<ApiResponse> {
  if (ctx.credentialVault === null || ctx.identity === null || !ctx.multiUser) {
    return VAULT_UNAVAILABLE;
  }
  const kind = ctx.params.kind;
  if (!isCredentialKind(kind)) {
    return {
      status: 400,
      body: { error: 'unknown_kind', message: `Unknown credential kind "${kind}".` },
    };
  }
  const denial = await ctx.guardMutation({
    subject: { kind: 'factory', id: 'credentials' },
    command: `credential.save:${kind}`,
  });
  if (denial !== null) {
    return denial;
  }
  const body = asRecord(ctx.request.body);
  const value = str(body.value) ?? '';
  const shapeProblem = validateValueShape(kind, value);
  if (shapeProblem !== null) {
    return { status: 422, body: { error: 'invalid_value', message: shapeProblem } };
  }

  // Live probe (G17): invalid rejects with mint instructions; rate-limited is
  // VALID; unverifiable saves unvalidated (preflight re-checks before runs).
  const probe = await ctx.credentialProber(kind, value);
  if (probe.status === 'invalid') {
    return {
      status: 422,
      body: {
        error: 'credential_invalid',
        message: `${probe.detail ?? 'The credential failed its validation probe.'} ${MINT_INSTRUCTIONS[kind]}`,
        probe,
      },
    };
  }
  const written = await ctx.credentialVault.setCredential(ctx.identity.userId, kind, value, {
    validated: probe.status === 'valid' || probe.status === 'valid_rate_limited',
  });
  if (!written.ok) {
    return MASTER_KEY_UNREADABLE;
  }
  const rows = await ctx.credentialVault.getPresence(ctx.identity.userId);
  return {
    status: 200,
    body: {
      ...presenceBody(rows),
      probe,
      message:
        probe.status === 'valid_rate_limited'
          ? 'The credential is valid but currently rate-limited (usage window exhausted) — runs will wait for the window to reset.'
          : probe.status === 'unverifiable'
            ? `Saved, but the probe could not verify it right now${probe.detail !== undefined ? ` (${probe.detail})` : ''}. Preflight re-checks before any run.`
            : 'Credential validated and saved (encrypted at rest).',
    },
  };
}

/** The caller's non-terminal runs (named in delete/revoke confirmations, G11). */
async function activeRunsOf(ctx: RouteContext, userId: string): Promise<
  { runId: string; title?: string; status: string }[]
> {
  const active: { runId: string; title?: string; status: string }[] = [];
  for (const runId of await ctx.reader.listRuns()) {
    const run = projectRun(await ctx.reader.readRun(runId), runId);
    if (!isRealRun(run) || run.ownerId !== userId) {
      continue;
    }
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
      continue;
    }
    active.push({ runId, title: run.title, status: run.status });
  }
  return active;
}

async function deleteCredential(ctx: RouteContext): Promise<ApiResponse> {
  if (ctx.credentialVault === null || ctx.identity === null || !ctx.multiUser) {
    return VAULT_UNAVAILABLE;
  }
  const kind = ctx.params.kind;
  if (!isCredentialKind(kind)) {
    return {
      status: 400,
      body: { error: 'unknown_kind', message: `Unknown credential kind "${kind}".` },
    };
  }
  const denial = await ctx.guardMutation({
    subject: { kind: 'factory', id: 'credentials' },
    command: `credential.delete:${kind}`,
  });
  if (denial !== null) {
    return denial;
  }
  const body = asRecord(ctx.request.body);
  const activeRuns = await activeRunsOf(ctx, ctx.identity.userId);
  if (activeRuns.length > 0 && body.confirm !== true) {
    return {
      status: 409,
      body: {
        error: 'confirm_required',
        message:
          `You have ${activeRuns.length} active run(s) that execute on your credentials — ` +
          'deleting this one may block their next spawn (they will raise a fix-credentials ' +
          'intervention, not fail silently). Confirm to delete anyway.',
        activeRuns,
      },
    };
  }
  await ctx.credentialVault.removeCredential(ctx.identity.userId, kind);
  const rows = await ctx.credentialVault.getPresence(ctx.identity.userId);
  return { status: 200, body: { ...presenceBody(rows), deleted: kind } };
}

export function credentialRoutes(): RouteDef[] {
  return [
    { method: 'GET', pattern: '/api/credentials', access: 'authenticated', handler: listCredentials },
    {
      method: 'POST',
      pattern: '/api/credentials/:kind',
      access: 'authenticated',
      handler: saveCredential,
    },
    {
      method: 'POST',
      pattern: '/api/credentials/:kind/delete',
      access: 'authenticated',
      handler: deleteCredential,
    },
  ];
}
