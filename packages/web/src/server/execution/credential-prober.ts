/**
 * Live credential probes (multi-user U10).
 *
 * One probe per credential kind, run BEFORE a value is saved:
 *  - Claude/Codex values reuse the U6 bound-adapter machinery — a spawn-env
 *    bundle around JUST the candidate value, probed through the same
 *    `detectSetup` path executions use (gate-verified: the claude CLI honors
 *    env credentials; codex needs an ephemeral CODEX_HOME).
 *  - GitHub/Render/Vercel tokens ping their APIs directly.
 *
 * Outcomes distinguish auth-failure from usage-limited/transient (G17):
 * `invalid` (reject), `valid_rate_limited` (save as valid, honest copy), and
 * `unverifiable` (save unvalidated — the CLI may simply be missing here).
 * Candidate values never leave this module except inside the probe transport.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createClaudeCodeCliAdapter,
  createCodexCliAdapter,
  createSpawnEnvBundle,
} from '@software-factory/core';
import type { AdapterSetupState, CredentialKind } from '@software-factory/core';
import { CODEX_HOME_PREFIX } from './credential-bundles';
import type { CredentialProbeOutcome, CredentialProber } from '../routes/credentials';

/** Bounded probe time so a wizard save can never hang. */
const HTTP_PROBE_TIMEOUT_MS = 10_000;

function fromSetupState(setup: AdapterSetupState, cliName: string): CredentialProbeOutcome {
  if (!setup.available) {
    return {
      status: 'unverifiable',
      detail: `The ${cliName} CLI is not installed on this server, so the value could not be probed.`,
    };
  }
  if (setup.authenticated) {
    return { status: 'valid', detail: setup.detail };
  }
  return { status: 'invalid', detail: setup.detail ?? 'The CLI rejected the credential.' };
}

async function probeHttp(
  url: string,
  token: string,
  extraHeaders: Record<string, string> = {},
): Promise<CredentialProbeOutcome> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, ...extraHeaders },
      signal: AbortSignal.timeout(HTTP_PROBE_TIMEOUT_MS),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 'unverifiable', detail: `Probe request failed: ${message}` };
  }
  if (res.ok) {
    return { status: 'valid' };
  }
  if (res.status === 401) {
    return { status: 'invalid', detail: 'The API rejected the token (401).' };
  }
  if (res.status === 429) {
    return { status: 'valid_rate_limited', detail: 'The API accepted auth but is rate-limiting.' };
  }
  if (res.status === 403) {
    // GitHub reports an exhausted rate limit as 403 with the remaining header.
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (remaining === '0') {
      return {
        status: 'valid_rate_limited',
        detail: 'The token authenticated but its API rate limit is exhausted right now.',
      };
    }
    return { status: 'invalid', detail: 'The API refused the token (403).' };
  }
  return { status: 'unverifiable', detail: `Unexpected probe response ${res.status}.` };
}

/** Build the default runtime prober (tests inject fakes at the route seam). */
export function createRuntimeCredentialProber(): CredentialProber {
  return async (kind: CredentialKind, value: string): Promise<CredentialProbeOutcome> => {
    switch (kind) {
      case 'claude_oauth_token':
      case 'anthropic_api_key': {
        const spawnEnv = createSpawnEnvBundle(
          kind === 'claude_oauth_token'
            ? { CLAUDE_CODE_OAUTH_TOKEN: value }
            : { ANTHROPIC_API_KEY: value },
        );
        const setup = await createClaudeCodeCliAdapter({ spawnEnv }).detectSetup();
        return fromSetupState(setup, 'claude');
      }
      case 'openai_api_key': {
        const spawnEnv = createSpawnEnvBundle({ OPENAI_API_KEY: value });
        const setup = await createCodexCliAdapter({ spawnEnv }).detectSetup();
        return fromSetupState(setup, 'codex');
      }
      case 'codex_auth_json': {
        // Ephemeral CODEX_HOME, exactly like execution binding (U7).
        const home = await mkdtemp(join(tmpdir(), CODEX_HOME_PREFIX));
        try {
          await writeFile(join(home, 'auth.json'), value, { encoding: 'utf8', mode: 0o600 });
          const spawnEnv = createSpawnEnvBundle({ CODEX_HOME: home });
          const setup = await createCodexCliAdapter({ spawnEnv }).detectSetup();
          return fromSetupState(setup, 'codex');
        } finally {
          await rm(home, { recursive: true, force: true });
        }
      }
      case 'github_token':
        return probeHttp('https://api.github.com/user', value, {
          accept: 'application/vnd.github+json',
          'user-agent': 'asapwaire-factory',
        });
      case 'render_api_key':
        return probeHttp('https://api.render.com/v1/owners?limit=1', value, {
          accept: 'application/json',
        });
      case 'vercel_token':
        return probeHttp('https://api.vercel.com/v2/user', value, {
          accept: 'application/json',
        });
      default: {
        const exhaustive: never = kind;
        return { status: 'unverifiable', detail: `No probe for ${String(exhaustive)}.` };
      }
    }
  };
}
