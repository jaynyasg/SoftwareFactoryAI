import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/index';

describe('parseArgs', () => {
  it('does not let a bare boolean flag (--json) consume the following positional', () => {
    const parsed = parseArgs(['status', '--json', 'run-123']);
    expect(parsed.command).toBe('status');
    expect(parsed.flags.get('json')).toBe(true);
    // run-123 must remain a positional (the runId), not be eaten by --json.
    expect(parsed.positionals).toEqual(['run-123']);
  });

  it('preserves the prompt positional after --no-follow', () => {
    const parsed = parseArgs(['run', '--no-follow', 'build a marketplace']);
    expect(parsed.command).toBe('run');
    expect(parsed.flags.get('no-follow')).toBe(true);
    expect(parsed.positionals).toEqual(['build a marketplace']);
  });

  it('still parses --key value and --key=value value flags', () => {
    const parsed = parseArgs(['run', '--worker-cap', '5', '--review-mode=autonomous', 'a prompt']);
    expect(parsed.flags.get('worker-cap')).toBe('5');
    expect(parsed.flags.get('review-mode')).toBe('autonomous');
    expect(parsed.positionals).toEqual(['a prompt']);
  });
});
