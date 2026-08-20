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
