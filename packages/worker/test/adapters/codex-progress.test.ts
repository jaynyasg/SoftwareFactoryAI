/**
 * Codex worker visibility + the stdin stall guard:
 *  - `codex exec --json` items become live worker.progress messages,
 *  - spawned children NEVER inherit a silently-open stdin pipe (codex exec
 *    blocks forever on "Reading additional input from stdin..." otherwise —
 *    observed live as a worker stalled 37 minutes at ~0 CPU).
 */
import { describe, expect, it } from 'vitest';
import { createCodexProgressParser, createNodeCommandRunner } from '@software-factory/core';

describe('createCodexProgressParser', () => {
  it('turns command and file items into progress messages, across chunk boundaries', () => {
    const parse = createCodexProgressParser();
    const started = JSON.stringify({
      type: 'item.started',
      item: { id: 'i1', type: 'command_execution', command: 'node test.js', status: 'in_progress' },
    });
    const file = JSON.stringify({
      type: 'item.started',
      item: {
        id: 'i2',
        type: 'file_change',
        changes: [{ path: 'vault/note.md', kind: 'add' }],
        status: 'in_progress',
      },
    });
    const half = Math.floor(started.length / 2);
    expect(parse('stdout', started.slice(0, half))).toEqual([]);
    expect(parse('stdout', started.slice(half) + '\n')).toEqual(['Run: node test.js']);
    expect(parse('stdout', file + '\n')).toEqual(['Write: vault/note.md']);
  });

  it('surfaces error items and ignores narration, stderr, and non-JSON', () => {
    const parse = createCodexProgressParser();
    const error = JSON.stringify({
      type: 'item.completed',
      item: { id: 'e1', type: 'error', message: 'Exceeded skills context budget.' },
    });
    const chatter = JSON.stringify({
      type: 'item.completed',
      item: { id: 'a1', type: 'agent_message', text: 'Working on it.' },
    });
    expect(parse('stdout', error + '\n' + chatter + '\n{oops\n')).toEqual([
      'codex: Exceeded skills context budget.',
    ]);
    expect(parse('stderr', 'noise\n')).toEqual([]);
  });
});

describe('node command runner stdin guarantee', () => {
  it('closes stdin when no input is provided (children must never wait on it)', async () => {
    const runner = createNodeCommandRunner();
    const result = await runner.run(
      'node',
      ['-e', 'process.stdin.on("data",()=>{}).on("end",()=>process.stdout.write("stdin-ended"))'],
      { timeoutMs: 15000 },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('stdin-ended');
  });

  it('still delivers provided input before closing', async () => {
    const runner = createNodeCommandRunner();
    const result = await runner.run(
      'node',
      ['-e', 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write("got:"+d))'],
      { timeoutMs: 15000, input: 'hello' },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('got:hello');
  });
});
