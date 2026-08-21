/**
 * Per-run credential binding (multi-user U7).
 *
 * The executor resolves the run OWNER's credentials just-in-time — decrypt
 * late, never cached in module state — and binds them into a per-job adapter
 * catalog through the U6 spawn-env seam, so selection-time probes, the
 * scheduler's setup probe, and every worker spawn all run owner-scoped.
 *
 * Codex `auth.json` uploads are materialized into an EPHEMERAL home under the
 * OS temp directory (never the factory dir): written 0600 at bind time,
 * deleted in `release()` on completion AND failure, swept at boot for
 * leftovers from a crashed process. Release also WRITES BACK a refreshed
 * auth.json (the codex CLI rotates tokens): re-encrypted into the vault under
 * a per-user mutex, and ONLY when the vault record is still the one this run
 * bound — a fresh upload during the run wins over the stale write-back.
 *
 * Failure classes are typed, owner- or admin-directed (R14/G7/G15):
 *  - `missing_credentials` — the owner has no usable execution credential;
 *  - `master_key_unreadable` — the ADMIN must fix SF_MASTER_KEY; login and
 *    non-credential surfaces stay alive, runs block.
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSpawnEnvBundle } from '@software-factory/core';
import type {
  AdapterCatalog,
  CredentialVault,
  RunProjection,
  SpawnEnvBundle,
} from '@software-factory/core';
import { createRollingRedactor } from '@software-factory/worker';

/** Prefix for every ephemeral codex home this module creates. */
export const CODEX_HOME_PREFIX = 'sfai-codex-';

/** The per-run binding handed to the executor. */
export interface RunCredentialBinding {
  /** Adapter catalog with the owner's spawn-env bundle bound (U6). */
  readonly catalog: AdapterCatalog;
  /** Stateful per-run redactor over every decrypted credential value. */
  readonly redact: (text: string) => string;
  /**
   * Release the binding: write back a refreshed codex auth.json (newer upload
   * wins) and delete the ephemeral home. Idempotent; call in `finally`.
   */
  release(): Promise<void>;
}

/** Typed resolution outcome (never throws for credential/key problems). */
export type CredentialBindingResult =
  | { readonly ok: true; readonly binding: RunCredentialBinding }
  | {
      readonly ok: false;
      readonly kind: 'missing_credentials';
      readonly reason: string;
      readonly requiredAction: string;
    }
  | {
      readonly ok: false;
      readonly kind: 'master_key_unreadable';
      readonly reason: string;
      readonly requiredAction: string;
    };

/** Resolve the owner binding for one run (executor calls this per job). */
export type RunCredentialResolver = (run: RunProjection) => Promise<CredentialBindingResult>;

export interface CredentialResolverOptions {
  readonly vault: CredentialVault;
  /**
   * Build the bound adapter catalog for a spawn-env bundle. The server entry
   * point supplies the SAME construction it uses for the shared catalog, plus
   * the bundle: `(spawnEnv) => createDefaultAdapterCatalog({ …opts, spawnEnv })`.
   */
  readonly catalog: (spawnEnv: SpawnEnvBundle) => AdapterCatalog;
  /** Root for ephemeral codex homes. Defaults to the OS temp directory. */
  readonly tempRoot?: string;
  readonly clock?: () => number;
}

const MASTER_KEY_BLOCK = {
  ok: false,
  kind: 'master_key_unreadable',
  reason:
    'The credential vault cannot be decrypted: the SF_MASTER_KEY this server booted with does ' +
    'not open the stored credentials.',
  requiredAction:
    'ADMIN action: restore the correct SF_MASTER_KEY on the server environment and restart. ' +
    'User logins and non-credential surfaces keep working; runs stay blocked until the key is fixed.',
} as const;

/** Per-user promise chain: serializes codex write-backs against uploads. */
const writeBackLocks = new Map<string, Promise<void>>();

function withUserLock<T>(userId: string, task: () => Promise<T>): Promise<T> {
  const previous = writeBackLocks.get(userId) ?? Promise.resolve();
  const next = previous.then(task, task);
  writeBackLocks.set(
    userId,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

/**
 * Boot orphan sweep: remove leftover ephemeral codex homes from a crashed
 * process. Call ONCE at server boot, before any run executes — never while
 * runs are in flight (a live run's home matches the same prefix).
 */
export async function sweepOrphanCodexHomes(tempRoot: string = tmpdir()): Promise<readonly string[]> {
  let entries: readonly string[];
  try {
    entries = await readdir(tempRoot);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.startsWith(CODEX_HOME_PREFIX)) {
      continue;
    }
    const path = join(tempRoot, entry);
    try {
      await rm(path, { recursive: true, force: true });
      removed.push(path);
    } catch {
      // A sweep failure is not fatal; the next boot retries.
    }
  }
  return removed;
}

/** Minimum length for an inner codex value to be worth registering as a secret. */
const MIN_INNER_SECRET_LEN = 8;
/** Hard cap on inner secrets collected from one blob (real codex has ~4). */
const MAX_INNER_SECRETS = 16;

/**
 * Collect the SECRET-bearing string values from a codex `auth.json` blob so the
 * per-run redactor scrubs the INNER tokens (`tokens.access_token`, `id_token`,
 * `refresh_token`, a top-level `OPENAI_API_KEY`, …) — not just the whole-blob
 * string. The whole-blob entry only matches a verbatim file dump; the codex CLI
 * and its errors surface an individual inner token far more often, and that lone
 * token would otherwise reach the append-only ledger unredacted (#18).
 *
 * SCOPED, not a walk of every string leaf. The blob is user-supplied, so an
 * every-leaf walk let a user weaponize their OWN upload: register a common word
 * ("error") as a global redaction pattern to mask their run's diagnostics, or
 * pack thousands of distinct short strings to amplify per-line redaction cost in
 * the shared execution daemon. Instead:
 *  - collect only the top-level `OPENAI_API_KEY` and the values under `tokens`
 *    (the codex CLI's token subtree — where the real secrets live);
 *  - require {@link MIN_INNER_SECRET_LEN} chars, so common words and short
 *    structural fragments can never become redaction targets; and
 *  - cap the count at {@link MAX_INNER_SECRETS}, bounding amplification even if
 *    the token subtree itself is stuffed with junk.
 * Walking the subtree (rather than hard-coding `access_token`/etc.) tolerates
 * codex shape drift; the whole-blob entry still covers a verbatim dump.
 *
 * Malformed or non-object JSON is tolerated (returns none): the caller still
 * registers the raw blob.
 */
function collectCodexAuthSecrets(codexAuthJson: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(codexAuthJson);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== 'object') {
    return [];
  }
  const out: string[] = [];
  const collect = (node: unknown): void => {
    if (out.length >= MAX_INNER_SECRETS) {
      return;
    }
    if (typeof node === 'string') {
      // Real tokens are long and few; a value at least this long is worth
      // scrubbing, a shorter one is a common word / flag / structural fragment.
      if (node.length >= MIN_INNER_SECRET_LEN) {
        out.push(node);
      }
    } else if (Array.isArray(node)) {
      for (const item of node) {
        collect(item);
      }
    } else if (node !== null && typeof node === 'object') {
      for (const value of Object.values(node)) {
        collect(value);
      }
    }
  };
  const record = parsed as Record<string, unknown>;
  collect(record.OPENAI_API_KEY);
  collect(record.tokens);
  return out;
}

/**
 * Build the run credential resolver. Decryption happens INSIDE each resolve
 * call (decrypt late); nothing plaintext is retained in module state.
 */
export function createRunCredentialResolver(
  options: CredentialResolverOptions,
): RunCredentialResolver {
  const { vault } = options;
  const tempRoot = options.tempRoot ?? tmpdir();
  const clock = options.clock ?? Date.now;

  return async (run) => {
    const ownerId = run.ownerId;
    if (ownerId === undefined) {
      // A legacy (pre-accounts) run on a multi-user instance has no owner to
      // bill or bind: block honestly instead of guessing at credentials.
      return {
        ok: false,
        kind: 'missing_credentials',
        reason:
          'This run predates multi-user accounts, so no owner credentials exist to execute it with.',
        requiredAction:
          'Re-create the run from an account with execution credentials (Settings → Credentials).',
      };
    }
    if (!vault.readable) {
      return MASTER_KEY_BLOCK;
    }

    // Decrypt late: each read happens here, immediately before binding.
    const read = async (kind: Parameters<CredentialVault['readCredential']>[1]) => {
      const result = await vault.readCredential(ownerId, kind);
      if (!result.ok && result.reason === 'master_key_unreadable') {
        throw new Error('master_key_unreadable');
      }
      if (!result.ok && result.reason === 'unreadable') {
        // An individually corrupt blob behaves like a wrong master key for
        // this user: surface the admin-directed block rather than silently
        // executing without the credential the owner uploaded.
        throw new Error('master_key_unreadable');
      }
      return result.ok ? result.value : undefined;
    };

    let claudeOauth: string | undefined;
    let anthropicKey: string | undefined;
    let openaiKey: string | undefined;
    let codexAuthJson: string | undefined;
    try {
      claudeOauth = await read('claude_oauth_token');
      anthropicKey = claudeOauth === undefined ? await read('anthropic_api_key') : undefined;
      openaiKey = await read('openai_api_key');
      codexAuthJson = openaiKey === undefined ? await read('codex_auth_json') : undefined;
    } catch {
      return MASTER_KEY_BLOCK;
    }

    if (
      claudeOauth === undefined &&
      anthropicKey === undefined &&
      openaiKey === undefined &&
      codexAuthJson === undefined
    ) {
      return {
        ok: false,
        kind: 'missing_credentials',
        reason:
          'No usable execution credential is stored for this account (Claude OAuth token, ' +
          'Anthropic API key, OpenAI API key, or Codex auth.json).',
        requiredAction:
          'Add an execution credential under Settings → Credentials, then retry the run. ' +
          'Runs execute on YOUR accounts — the server has no shared fallback.',
      };
    }

    // Ephemeral codex home for an auth.json upload (never the factory dir).
    let codexHome: string | undefined;
    const boundAt = clock();
    if (codexAuthJson !== undefined) {
      codexHome = await mkdtemp(join(tempRoot, CODEX_HOME_PREFIX));
      await writeFile(join(codexHome, 'auth.json'), codexAuthJson, {
        encoding: 'utf8',
        mode: 0o600,
      });
    }

    const spawnEnv = createSpawnEnvBundle({
      CLAUDE_CODE_OAUTH_TOKEN: claudeOauth,
      ANTHROPIC_API_KEY: anthropicKey,
      OPENAI_API_KEY: openaiKey,
      CODEX_HOME: codexHome,
    });

    const secretValues = [claudeOauth, anthropicKey, openaiKey, codexAuthJson].filter(
      (value): value is string => value !== undefined,
    );
    // #18: also register the INNER token values from a codex auth.json blob, so
    // a subprocess that echoes just an access/refresh/id token (not the whole
    // file) is still scrubbed from ledger-bound output. The whole-blob string
    // above only matches a verbatim dump.
    if (codexAuthJson !== undefined) {
      secretValues.push(...collectCodexAuthSecrets(codexAuthJson));
    }

    let released = false;
    const release = async (): Promise<void> => {
      if (released || codexHome === undefined) {
        released = true;
        return;
      }
      released = true;
      const home = codexHome;
      try {
        await withUserLock(ownerId, async () => {
          let refreshed: string | undefined;
          try {
            refreshed = await readFile(join(home, 'auth.json'), 'utf8');
          } catch {
            refreshed = undefined;
          }
          if (refreshed === undefined || refreshed === codexAuthJson) {
            return;
          }
          // Newer upload wins: only write back when the vault record is still
          // the one this run bound (no upload landed since boundAt).
          const presence = await vault.getPresence(ownerId);
          const current = presence.find((row) => row.kind === 'codex_auth_json');
          if (current?.present !== true || (current.updatedAt ?? 0) > boundAt) {
            return;
          }
          await vault.setCredential(ownerId, 'codex_auth_json', refreshed, { validated: true });
        });
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    };

    return {
      ok: true,
      binding: {
        catalog: options.catalog(spawnEnv),
        redact: createRollingRedactor(secretValues),
        release,
      },
    };
  };
}
