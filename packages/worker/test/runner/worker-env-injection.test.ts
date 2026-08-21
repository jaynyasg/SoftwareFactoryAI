/**
 * U6 — spawn-env composition with the replaceEnv allowlist (AE1).
 *
 * The security core of multi-user execution: when an adapter is constructed
 * with a spawn-env bundle, every child it spawns (setup probes AND execution)
 * runs with an EXCLUSIVE environment — essentials allowlist + nested-session
 * scrub + the bundle (bundle wins) — so server secrets in `process.env` can
 * NEVER reach a worker CLI. Without a bundle the spawn env is byte-identical
 * to the historical inherit+scrub behavior.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  composeSpawnEnv,
  createClaudeCodeCliAdapter,
  createCodexCliAdapter,
  createDefaultAdapterCatalog,
  createSpawnEnvBundle,
  scrubNestedSessionEnv,
  type AdapterTask,
  type CommandRunOptions,
  type CommandRunner,
  type CommandResult,
} from '@software-factory/core';

interface RecordedRun {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: CommandRunOptions;
}

/** A fake runner that records every spawn and answers success. */
function recordingRunner(): { runner: CommandRunner; calls: RecordedRun[] } {
  const calls: RecordedRun[] = [];
  const runner: CommandRunner = {
    run: (command, args, options = {}) => {
      calls.push({ command, args, options });
      const result: CommandResult = { code: 0, stdout: 'ok 1.0.0', stderr: '' };
      return Promise.resolve(result);
    },
  };
  return { runner, calls };
}

const TASK: AdapterTask = {
  runId: 'run-1',
  ticketId: 'tkt-1',
  title: 'Env-injection ticket',
  workspaceDir: 'C:/tmp/ws',
  context: {
    ticketId: 'tkt-1',
    title: 'Env-injection ticket',
    moduleId: 'm',
    moduleVersion: '1.0.0',
    intent: 'ai-services-marketplace',
    prompt: 'Do the thing.',
    riskTier: 'low' as const,
    resolvedInputs: [],
    missingInputs: [],
    allowedTools: [],
    deniedTools: [],
    expectedOutputs: ['output'],
    artifactContracts: [],
    gateFeedback: [],
    complete: true,
  },
};

function execOpts(): {
  signal: AbortSignal;
  onEvent: () => void;
} {
  return { signal: new AbortController().signal, onEvent: () => undefined };
}

/** Sentinel server-side secrets that must NEVER reach a child process. */
const SENTINELS: Record<string, string> = {
  SF_MASTER_KEY: 'sentinel-master-key',
  SF_MASTER_KEY_PREVIOUS: 'sentinel-previous-key',
  SF_BOOTSTRAP_INVITE: 'sentinel-bootstrap',
  SF_GIT_CHECKOUT_TOKEN: 'sentinel-checkout',
  SF_OPERATOR_TOKEN: 'sentinel-operator',
};

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const [key, value] of Object.entries({
    ...SENTINELS,
    ANTHROPIC_API_KEY: 'server-anthropic-key',
    CLAUDECODE: '1',
    ANTHROPIC_BASE_URL: 'http://host-proxy.invalid',
  })) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe('createSpawnEnvBundle (validation at construction)', () => {
  it('rejects every SF_* variable — server secrets cannot even be STAGED for a spawn', () => {
    for (const key of Object.keys(SENTINELS)) {
      expect(() => createSpawnEnvBundle({ [key]: 'x' }), key).toThrow(/SF_/);
    }
  });

  it('rejects two Claude credentials at once (exactly one of OAuth token / API key)', () => {
    expect(() =>
      createSpawnEnvBundle({
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
        ANTHROPIC_API_KEY: 'api-key',
      }),
    ).toThrow(/one Claude credential/i);
  });

  it('rejects OPENAI_API_KEY and CODEX_HOME together (exactly one codex credential form)', () => {
    expect(() =>
      createSpawnEnvBundle({ OPENAI_API_KEY: 'key', CODEX_HOME: 'C:/codex-home' }),
    ).toThrow(/codex credential/i);
  });

  it('drops undefined values and accepts a mixed claude+codex bundle', () => {
    const bundle = createSpawnEnvBundle({
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
      CODEX_HOME: 'C:/codex-home',
      GITHUB_TOKEN: undefined,
    });
    expect(Object.keys(bundle.env).sort()).toEqual(['CLAUDE_CODE_OAUTH_TOKEN', 'CODEX_HOME']);
  });
});

describe('composeSpawnEnv (essentials → scrub → bundle)', () => {
  it('AE1: the composed env carries ONLY essentials + bundle — no server secret leaks', () => {
    const bundle = createSpawnEnvBundle({ CLAUDE_CODE_OAUTH_TOKEN: 'user-oauth' });
    const env = composeSpawnEnv(bundle);
    for (const key of Object.keys(SENTINELS)) {
      expect(env[key], key).toBeUndefined();
    }
    // The server's own Anthropic key is NOT an essential — it stays server-side.
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('user-oauth');
    // Children still need a PATH to find the CLI at all.
    const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH');
    expect(pathKey).toBeDefined();
  });

  it('nested-session markers are blanked on top of the bundle (scrub carve-outs apply)', () => {
    const bundle = createSpawnEnvBundle({ OPENAI_API_KEY: 'user-openai' });
    const env = composeSpawnEnv(bundle);
    // Present-but-empty: falsy for the CLI presence checks (same as inherit mode).
    expect(env.CLAUDECODE).toBe('');
    expect(env.ANTHROPIC_BASE_URL).toBe('');
  });

  it('the bundle WINS over essentials and scrub (composition order pinned)', () => {
    const bundle = createSpawnEnvBundle({ HOME: 'C:/bundle-home' });
    const env = composeSpawnEnv(bundle);
    expect(env.HOME).toBe('C:/bundle-home');
  });
});

describe('CLI adapters with a spawn-env bundle (probes AND execution)', () => {
  it('claude adapter: probe + exec spawns get exclusive env; server ANTHROPIC_API_KEY absent', async () => {
    const { runner, calls } = recordingRunner();
    const bundle = createSpawnEnvBundle({ CLAUDE_CODE_OAUTH_TOKEN: 'user-oauth' });
    const adapter = createClaudeCodeCliAdapter({ runner, spawnEnv: bundle });

    await adapter.detectSetup();
    await adapter.execute({ ...TASK }, execOpts());

    // Version probe + auth probe + execution = 3 spawns, all exclusive.
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const call of calls) {
      expect(call.options.replaceEnv, `${call.command} ${call.args.join(' ')}`).toBe(true);
      const env = call.options.env ?? {};
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('user-oauth');
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      for (const key of Object.keys(SENTINELS)) {
        expect(env[key], key).toBeUndefined();
      }
    }
  });

  it('codex adapter receives the bundle CODEX_HOME; the claude adapter NEVER does', async () => {
    const bundle = createSpawnEnvBundle({
      CLAUDE_CODE_OAUTH_TOKEN: 'user-oauth',
      CODEX_HOME: 'C:/users/u1/codex-home',
    });

    const codex = recordingRunner();
    await createCodexCliAdapter({ runner: codex.runner, spawnEnv: bundle }).detectSetup();
    expect(codex.calls.length).toBeGreaterThan(0);
    for (const call of codex.calls) {
      expect(call.options.env?.CODEX_HOME).toBe('C:/users/u1/codex-home');
      // Codex never sees the other family's credential.
      expect(call.options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    }

    const claude = recordingRunner();
    await createClaudeCodeCliAdapter({ runner: claude.runner, spawnEnv: bundle }).detectSetup();
    expect(claude.calls.length).toBeGreaterThan(0);
    for (const call of claude.calls) {
      expect(call.options.env?.CODEX_HOME).toBeUndefined();
      expect(call.options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe('user-oauth');
    }
  });

  it('regression pin: WITHOUT a bundle the spawn env is byte-identical inherit+scrub', async () => {
    const { runner, calls } = recordingRunner();
    const adapter = createClaudeCodeCliAdapter({ runner });

    await adapter.detectSetup();
    await adapter.execute({ ...TASK }, execOpts());

    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const call of calls) {
      expect(call.options.replaceEnv).toBeUndefined();
      expect(call.options.env).toEqual(scrubNestedSessionEnv());
    }
  });

  it('the default catalog binds the bundle to BOTH CLI adapters at construction', async () => {
    const { runner, calls } = recordingRunner();
    const bundle = createSpawnEnvBundle({
      CLAUDE_CODE_OAUTH_TOKEN: 'user-oauth',
      OPENAI_API_KEY: 'user-openai',
    });
    const catalog = createDefaultAdapterCatalog({ runner, spawnEnv: bundle });

    for (const adapter of catalog.list()) {
      if (adapter.family !== 'codex' && adapter.family !== 'claude') {
        continue;
      }
      calls.length = 0;
      await adapter.detectSetup();
      expect(calls.length, adapter.id).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.options.replaceEnv, adapter.id).toBe(true);
        for (const key of Object.keys(SENTINELS)) {
          expect(call.options.env?.[key], `${adapter.id} ${key}`).toBeUndefined();
        }
      }
    }
  });
});
