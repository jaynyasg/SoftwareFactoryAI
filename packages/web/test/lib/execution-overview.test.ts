/**
 * Shared execution-overview parsing tests. `parseExecutionOverview` is the ONE
 * structural parser behind the browser client (fetchExecutionOverview), the
 * SSR loader (loadExecutionOverview), and the FactoryFloor default prop, so a
 * malformed or missing wire body must degrade to the disabled defaults instead
 * of rendering `undefined` into the factory command bar.
 */
import { describe, expect, it } from 'vitest';
import {
  DISABLED_EXECUTION_OVERVIEW,
  parseExecutionOverview,
} from '../../src/lib/execution-overview';

describe('parseExecutionOverview', () => {
  it('round-trips a well-formed overview body', () => {
    const body = {
      execution: { enabled: true, held: true, running: false },
      queue: { queued: 3, leased: 1 },
    };
    expect(parseExecutionOverview(body)).toEqual(body);
  });

  it('degrades a missing execution/queue section to the disabled defaults', () => {
    expect(parseExecutionOverview({})).toEqual(DISABLED_EXECUTION_OVERVIEW);
  });

  it('degrades malformed field types to disabled/zeros instead of passing them through', () => {
    expect(
      parseExecutionOverview({
        execution: { enabled: 'yes', held: 1, running: null },
        queue: { queued: 'many', leased: undefined },
      }),
    ).toEqual(DISABLED_EXECUTION_OVERVIEW);
  });

  it('degrades field by field: valid flags survive a malformed sibling', () => {
    expect(
      parseExecutionOverview({
        execution: { enabled: true, held: 'nope' },
        queue: { queued: 2 },
      }),
    ).toEqual({
      execution: { enabled: true, held: false, running: false },
      queue: { queued: 2, leased: 0 },
    });
  });
});
