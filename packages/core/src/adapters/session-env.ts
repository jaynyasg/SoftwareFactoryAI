/**
 * Nested-session environment guard for worker CLI spawns.
 *
 * A factory server started from a shell that itself runs inside a Claude Code
 * session inherits that session's plumbing — `CLAUDECODE`, `CLAUDE_CODE_*`,
 * host default-model overrides, and (critically) `ANTHROPIC_BASE_URL`, which
 * points a child CLI at a host proxy it cannot authenticate to. A spawned
 * `claude --print` then hangs instead of answering (observed live: the same
 * call succeeds in ~6s once these variables are cleared).
 *
 * The child environment cannot DELETE inherited variables (env merge only
 * overrides), so the scrub sets each marker to the empty string — falsy for
 * the CLI's presence checks and treated as unset by its URL fallback.
 *
 * `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` (and other explicit
 * credentials) are deliberately NOT touched: operators who authenticate the
 * CLI via an API key — or a long-lived `claude setup-token` OAuth token on a
 * headless/cloud machine — keep working.
 */

import type { AdapterFamily } from './execution-adapter';

/** Explicit credentials that survive the scrub (see module doc). */
const CREDENTIAL_KEYS = new Set(['CLAUDE_CODE_OAUTH_TOKEN']);

/** Env-override map that neutralizes inherited Claude-session plumbing. */
export function scrubNestedSessionEnv(
  base: NodeJS.ProcessEnv = process.env,
): Readonly<Record<string, string>> {
  const overrides: Record<string, string> = {};
  for (const key of Object.keys(base)) {
    if (CREDENTIAL_KEYS.has(key)) {
      continue;
    }
    if (
      key === 'CLAUDECODE' ||
      key.startsWith('CLAUDE_') ||
      key.startsWith('ANTHROPIC_DEFAULT_') ||
      key === 'ANTHROPIC_BASE_URL'
    ) {
      overrides[key] = '';
    }
  }
  return overrides;
}

/* ----------------------------------------------------------------------------
 * Spawn-env bundles (multi-user U6 / AE1)
 *
 * A bundle carries ONE user's execution credentials. An adapter constructed
 * with a bundle spawns its children (setup probes AND execution) with an
 * EXCLUSIVE environment — the essentials allowlist below + the nested-session
 * scrub + the bundle (bundle wins) — instead of inheriting `process.env`, so
 * server-side secrets can never reach a worker CLI.
 * ------------------------------------------------------------------------- */

/**
 * Server-secret namespace: NO `SF_*` variable may appear in a bundle or leak
 * through the essentials allowlist (master key, previous key, bootstrap
 * invite, checkout token, operator token — the lot).
 */
const SERVER_SECRET_PREFIX = 'SF_';

/** Exactly one Claude credential form may be present in a bundle. */
const CLAUDE_CREDENTIAL_KEYS = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'] as const;
/** Exactly one Codex credential form may be present in a bundle. */
const CODEX_CREDENTIAL_KEYS = ['OPENAI_API_KEY', 'CODEX_HOME'] as const;

/** A validated per-user spawn environment (construct via createSpawnEnvBundle). */
export interface SpawnEnvBundle {
  readonly env: Readonly<Record<string, string>>;
}

/**
 * Validate and freeze a spawn-env bundle. Rejects (fail closed, at
 * construction — long before any spawn):
 *  - any `SF_*` server variable,
 *  - both Claude credential forms at once,
 *  - both Codex credential forms at once (`OPENAI_API_KEY` xor `CODEX_HOME`).
 * `undefined` values are dropped so callers can pass optional lookups directly.
 */
export function createSpawnEnvBundle(
  values: Readonly<Record<string, string | undefined>>,
): SpawnEnvBundle {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      continue;
    }
    if (key.toUpperCase().startsWith(SERVER_SECRET_PREFIX)) {
      throw new Error(
        `Spawn-env bundle rejected: "${key}" is in the SF_* server-secret namespace and must never reach a worker spawn.`,
      );
    }
    env[key] = value;
  }
  const claude = CLAUDE_CREDENTIAL_KEYS.filter((key) => env[key] !== undefined);
  if (claude.length > 1) {
    throw new Error(
      `Spawn-env bundle rejected: carry exactly one Claude credential (got ${claude.join(' AND ')}).`,
    );
  }
  const codex = CODEX_CREDENTIAL_KEYS.filter((key) => env[key] !== undefined);
  if (codex.length > 1) {
    throw new Error(
      `Spawn-env bundle rejected: carry exactly one Codex credential form (got ${codex.join(' AND ')}).`,
    );
  }
  return { env: Object.freeze(env) };
}

/** Uppercased names a CLI child needs to run at all (cross-platform). */
const ESSENTIAL_KEYS = new Set([
  'PATH',
  'PATHEXT',
  'COMSPEC',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'USER',
  'USERNAME',
  'LOGNAME',
  'SHELL',
  'LANG',
  'TERM',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
]);

/** Uppercased prefixes admitted by the essentials allowlist. */
const ESSENTIAL_PREFIXES = ['LC_', 'XDG_'];

/**
 * The essentials allowlist over a base environment: only what a CLI child
 * needs to start (PATH, temp/home dirs, locale, proxies). Everything else —
 * server secrets, host credentials, session plumbing — is dropped. `SF_*` is
 * additionally hard-denied even if a future edit were to allowlist one.
 */
export function essentialSpawnEnv(
  base: NodeJS.ProcessEnv = process.env,
): Readonly<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) {
      continue;
    }
    const upper = key.toUpperCase();
    if (upper.startsWith(SERVER_SECRET_PREFIX)) {
      continue;
    }
    if (ESSENTIAL_KEYS.has(upper) || ESSENTIAL_PREFIXES.some((prefix) => upper.startsWith(prefix))) {
      env[key] = value;
    }
  }
  return env;
}

/**
 * Compose the EXCLUSIVE child environment for a bundle-bound spawn. Order is
 * pinned by tests: essentials → nested-session scrub overrides → bundle (the
 * bundle wins). The scrub keeps inherited Claude-session markers present-but-
 * blank exactly like inherit mode, so CLI presence checks behave identically.
 */
export function composeSpawnEnv(
  bundle: SpawnEnvBundle,
  base: NodeJS.ProcessEnv = process.env,
): Readonly<Record<string, string>> {
  return { ...essentialSpawnEnv(base), ...scrubNestedSessionEnv(base), ...bundle.env };
}

/**
 * Narrow a bundle to the keys one adapter family may see: a Claude spawn never
 * receives `CODEX_HOME`/`OPENAI_API_KEY` and a Codex spawn never receives the
 * Claude credentials. Family-neutral keys pass through to both.
 */
export function bundleEnvForFamily(bundle: SpawnEnvBundle, family: AdapterFamily): SpawnEnvBundle {
  const exclude: readonly string[] =
    family === 'claude'
      ? CODEX_CREDENTIAL_KEYS
      : family === 'codex'
        ? CLAUDE_CREDENTIAL_KEYS
        : [...CLAUDE_CREDENTIAL_KEYS, ...CODEX_CREDENTIAL_KEYS];
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(bundle.env)) {
    if (!exclude.includes(key)) {
      env[key] = value;
    }
  }
  return { env: Object.freeze(env) };
}
