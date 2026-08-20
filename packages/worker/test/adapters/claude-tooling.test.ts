/**
 * Claude adapter production plumbing:
 *  - genome tool grants map to REAL Claude Code tool names on --allowedTools
 *    (without this, --print mode denies every write and builds nothing),
 *  - the --output-format json result envelope is unwrapped (and an error
 *    envelope with exit 0 is a REAL failure, never ticket output),
 *  - spawns clear inherited Claude-session env (nested-session hang guard).
 */
import { describe, expect, it } from 'vitest';
import {
  createClaudeCodeCliAdapter,
  createClaudeProgressParser,
  createCodexCliAdapter,
  mapGenomeToolsToClaude,
  scrubNestedSessionEnv,
} from '@software-factory/core';
import type { AdapterTask, WorkerContext } from '@software-factory/core';
import { createFakeRunner } from '../_helpers/fake-runner';

function context(allowedTools: readonly string[]): WorkerContext {
  return {
    ticketId: 'tkt-1',
    title: 'Build ticket',
    moduleId: 'm',
    moduleVersion: '1.0.0',
    intent: 'unknown',
    prompt: 'Build the thing.',
    riskTier: 'low',
    resolvedInputs: [],
    missingInputs: [],
    allowedTools,
    deniedTools: [],
    expectedOutputs: ['output'],
    artifactContracts: [],
    gateFeedback: [],
    complete: true,
  };
}

function task(allowedTools: readonly string[]): AdapterTask {
  return {
    runId: 'run-1',
    ticketId: 'tkt-1',
    title: 'Build ticket',
    context: context(allowedTools),
    workspaceDir: '/tmp/ws',
  };
}

const signal = new AbortController().signal;
const execOptions = { signal, onEvent: () => {} };

describe('mapGenomeToolsToClaude', () => {
  it('maps the genome grant vocabulary to Claude Code tool names, deduped', () => {
    expect(mapGenomeToolsToClaude(['fs.read', 'fs.write', 'shell.exec'])).toEqual([
      'Read',
      'Glob',
      'Grep',
      'Write',
      'Edit',
      'Bash',
    ]);
    // pkg.install/test.run collapse into the already-granted Bash.
    expect(mapGenomeToolsToClaude(['shell.exec', 'pkg.install', 'test.run'])).toEqual(['Bash']);
  });

  it('passes already-Claude-shaped names through and drops unknown lowercase names', () => {
    expect(mapGenomeToolsToClaude(['WebSearch', 'made.up'])).toEqual(['WebSearch']);
  });
});

describe('claude adapter execution plumbing', () => {
  it('sends the MAPPED allow-list on --allowedTools', async () => {
    const fake = createFakeRunner({
      responses: {
        'claude --print': {
          code: 0,
          stdout: JSON.stringify({ type: 'result', subtype: 'success', result: 'done' }),
          stderr: '',
        },
      },
    });
    const adapter = createClaudeCodeCliAdapter({ runner: fake });
    await adapter.execute(task(['fs.read', 'fs.write', 'shell.exec']), execOptions);

    const exec = fake.calls.find((call) => call.args.includes('--allowedTools'));
    expect(exec).toBeDefined();
    const value = exec!.args[exec!.args.indexOf('--allowedTools') + 1];
    expect(value).toBe('Read,Glob,Grep,Write,Edit,Bash');
    // The prompt rides STDIN — a multi-line argv prompt cannot survive the
    // cmd.exe re-invocation of the Windows .cmd shim.
    expect(exec!.options?.input).toContain('Build the thing.');
    expect(exec!.args.some((arg) => arg.includes('Build the thing.'))).toBe(false);
  });

  it('unwraps the json result envelope into the ticket output', async () => {
    const fake = createFakeRunner({
      responses: {
        'claude --print': {
          code: 0,
          stdout: JSON.stringify({
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: 'Implemented the scaffold; files written to the workspace.',
          }),
          stderr: '',
        },
      },
    });
    const adapter = createClaudeCodeCliAdapter({ runner: fake });
    const result = await adapter.execute(task(['fs.write']), execOptions);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toBe('Implemented the scaffold; files written to the workspace.');
    }
  });

  it('treats a zero-exit ERROR envelope as a failure, never as output', async () => {
    const fake = createFakeRunner({
      responses: {
        'claude --print': {
          code: 0,
          stdout: JSON.stringify({
            type: 'result',
            subtype: 'error_during_execution',
            is_error: true,
            result: 'Credit balance too low.',
          }),
          stderr: '',
        },
      },
    });
    const adapter = createClaudeCodeCliAdapter({ runner: fake });
    const result = await adapter.execute(task(['fs.write']), execOptions);
    expect(result.ok).toBe(false);
  });

  it('clears inherited Claude-session env on every spawn (probes + exec)', async () => {
    const fake = createFakeRunner({
      responses: {
        'claude --print': {
          code: 0,
          stdout: JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }),
          stderr: '',
        },
      },
    });
    const adapter = createClaudeCodeCliAdapter({ runner: fake });
    await adapter.detectSetup();
    await adapter.execute(task([]), execOptions);
    const expected = scrubNestedSessionEnv();
    for (const call of fake.calls) {
      for (const [key, value] of Object.entries(expected)) {
        expect(call.options?.env?.[key]).toBe(value);
      }
    }
  });
});

describe('claude adapter streaming visibility', () => {
  it('executes in stream-json mode (with the required --verbose)', async () => {
    const fake = createFakeRunner({
      responses: {
        'claude --print': {
          code: 0,
          stdout: JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }),
          stderr: '',
        },
      },
    });
    const adapter = createClaudeCodeCliAdapter({ runner: fake });
    await adapter.execute(task([]), execOptions);
    const exec = fake.calls.find((call) => call.args.includes('--print'));
    expect(exec!.args).toContain('stream-json');
    expect(exec!.args).toContain('--verbose');
  });

  it('parses the final result envelope out of an NDJSON stream', async () => {
    const stream = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's-1' }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'a.js' } }] },
      }),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'built a.js' }),
      '',
    ].join('\n');
    const fake = createFakeRunner({
      responses: { 'claude --print': { code: 0, stdout: stream, stderr: '' } },
    });
    const adapter = createClaudeCodeCliAdapter({ runner: fake });
    const result = await adapter.execute(task(['fs.write']), execOptions);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toBe('built a.js');
    }
  });

  it('turns streamed tool uses into progress messages, across chunk boundaries', () => {
    const parse = createClaudeProgressParser();
    const line1 = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'vault/note.md' } }],
      },
    });
    const line2 = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'node test.js' } }] },
    });
    // Feed the stream in awkward chunks that split a line in half.
    const half = Math.floor(line1.length / 2);
    expect(parse('stdout', line1.slice(0, half))).toEqual([]);
    expect(parse('stdout', line1.slice(half) + '\n')).toEqual(['Write: vault/note.md']);
    expect(parse('stdout', line2 + '\n' + '{not json}\n')).toEqual(['Bash: node test.js']);
    // Stderr and text-only assistant turns yield nothing.
    expect(parse('stderr', 'noise\n')).toEqual([]);
    expect(
      parse(
        'stdout',
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }) +
          '\n',
      ),
    ).toEqual([]);
  });
});

describe('claude adapter skill access (opt-in, fail closed)', () => {
  const SUCCESS = {
    code: 0,
    stdout: JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }),
    stderr: '',
  };

  it('never allows the Skill tool by default', async () => {
    const fake = createFakeRunner({ responses: { 'claude --print': SUCCESS } });
    const adapter = createClaudeCodeCliAdapter({ runner: fake });
    await adapter.execute(task(['fs.write']), execOptions);
    const exec = fake.calls.find((call) => call.args.includes('--allowedTools'));
    expect(exec!.args[exec!.args.indexOf('--allowedTools') + 1]).not.toContain('Skill');
    expect(exec!.options?.input).not.toContain('skill');
  });

  it('allows the Skill tool and names the granted skills when opted in', async () => {
    const fake = createFakeRunner({ responses: { 'claude --print': SUCCESS } });
    const adapter = createClaudeCodeCliAdapter({
      runner: fake,
      allowedSkills: ['frontend-design', 'webapp-testing'],
    });
    await adapter.execute(task(['fs.write']), execOptions);
    const exec = fake.calls.find((call) => call.args.includes('--allowedTools'));
    expect(exec!.args[exec!.args.indexOf('--allowedTools') + 1]).toContain('Skill');
    expect(exec!.options?.input).toContain('ONLY these Claude Code skills');
    expect(exec!.options?.input).toContain('frontend-design, webapp-testing');
  });

  it("'*' allows any locally installed skill", async () => {
    const fake = createFakeRunner({ responses: { 'claude --print': SUCCESS } });
    const adapter = createClaudeCodeCliAdapter({ runner: fake, allowedSkills: ['*'] });
    await adapter.execute(task(['fs.write']), execOptions);
    const exec = fake.calls.find((call) => call.args.includes('--allowedTools'));
    expect(exec!.args[exec!.args.indexOf('--allowedTools') + 1]).toContain('Skill');
    expect(exec!.options?.input).toContain('any locally installed Claude Code skill');
  });

  it('steers workers toward preferred skill families when granted', async () => {
    const fake = createFakeRunner({ responses: { 'claude --print': SUCCESS } });
    const adapter = createClaudeCodeCliAdapter({
      runner: fake,
      allowedSkills: ['*'],
      preferredSkills: ['gstack', 'superpowers', 'gsd-*'],
    });
    await adapter.execute(task(['fs.write']), execOptions);
    const exec = fake.calls.find((call) => call.args.includes('--allowedTools'));
    expect(exec!.options?.input).toContain('Prefer these skill families');
    expect(exec!.options?.input).toContain('gstack, superpowers, gsd-*');
  });

  it('preference guidance never appears without a skill grant', async () => {
    const fake = createFakeRunner({ responses: { 'claude --print': SUCCESS } });
    const adapter = createClaudeCodeCliAdapter({
      runner: fake,
      preferredSkills: ['gstack'],
    });
    await adapter.execute(task(['fs.write']), execOptions);
    const exec = fake.calls.find((call) => call.args.includes('--allowedTools'));
    expect(exec!.args[exec!.args.indexOf('--allowedTools') + 1]).not.toContain('Skill');
    expect(exec!.options?.input).not.toContain('Prefer these skill families');
  });
});

describe('codex adapter skill steering (native skills, prompt guidance)', () => {
  it('appends preferred-skill guidance to the exec prompt when configured', async () => {
    const fake = createFakeRunner({
      responses: { 'codex exec': { code: 0, stdout: '{"ok":true}', stderr: '' } },
    });
    const adapter = createCodexCliAdapter({
      runner: fake,
      preferredSkills: ['gstack', 'anti-slop', 'gsd-*'],
    });
    await adapter.execute(task(['fs.write']), execOptions);
    const exec = fake.calls.find((call) => call.args[0] === 'exec');
    const prompt = exec!.args[exec!.args.length - 1];
    expect(prompt).toContain('Prefer these skill families');
    expect(prompt).toContain('gstack, anti-slop, gsd-*');
    // The truncation workaround: name-invocation works even off-list.
    expect(prompt).toContain('even when it is not shown in your visible skills list');
  });

  it('adds no skill guidance by default', async () => {
    const fake = createFakeRunner({
      responses: { 'codex exec': { code: 0, stdout: '{"ok":true}', stderr: '' } },
    });
    const adapter = createCodexCliAdapter({ runner: fake });
    await adapter.execute(task(['fs.write']), execOptions);
    const exec = fake.calls.find((call) => call.args[0] === 'exec');
    expect(exec!.args[exec!.args.length - 1]).not.toContain('skill');
  });
});

describe('scrubNestedSessionEnv', () => {
  it('empties session markers but never credentials', () => {
    const scrubbed = scrubNestedSessionEnv({
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_PID: '123',
      ANTHROPIC_BASE_URL: 'https://host.proxy',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'x',
      ANTHROPIC_API_KEY: 'sk-keep-me',
      PATH: 'C:\\bin',
    });
    expect(scrubbed).toEqual({
      CLAUDECODE: '',
      CLAUDE_CODE_ENTRYPOINT: '',
      CLAUDE_PID: '',
      ANTHROPIC_BASE_URL: '',
      ANTHROPIC_DEFAULT_OPUS_MODEL: '',
    });
    expect(scrubbed).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(scrubbed).not.toHaveProperty('PATH');
  });
});
