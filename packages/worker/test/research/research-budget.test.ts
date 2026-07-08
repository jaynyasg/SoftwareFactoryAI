/**
 * Research budget tracker (full-factory U2) — source-count, elapsed-time, and
 * per-source-class bounds with an injected deterministic clock.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_RESEARCH_BUDGET, createBudgetTracker } from '../../src/index';
import { steppingClock } from '../_helpers/research';

describe('createBudgetTracker', () => {
  it('applies defaults when no budget is configured', () => {
    const tracker = createBudgetTracker({}, steppingClock());
    expect(tracker.budget.maxSources).toBe(DEFAULT_RESEARCH_BUDGET.maxSources);
    expect(tracker.budget.maxDurationMs).toBe(DEFAULT_RESEARCH_BUDGET.maxDurationMs);
    expect(tracker.canReadSource('repo_scan')).toBeNull();
  });

  it('stops globally when the source budget is exhausted', () => {
    const tracker = createBudgetTracker({ maxSources: 2 }, steppingClock());
    expect(tracker.canReadSource('repo_scan')).toBeNull();
    tracker.noteSourceRead('repo_scan');
    expect(tracker.canReadSource('repo_scan')).toBeNull();
    tracker.noteSourceRead('repo_scan');

    const stop = tracker.canReadSource('repo_scan');
    expect(stop?.rule).toBe('max_sources');
    expect(stop?.global).toBe(true);
    expect(tracker.sourcesRead).toBe(2);
  });

  it('stops globally when the time budget elapses', () => {
    // Clock advances 1000ms per call: creation consumes one tick, so the third
    // check sees >= 3000ms elapsed.
    const tracker = createBudgetTracker({ maxDurationMs: 3000 }, steppingClock());
    expect(tracker.canReadSource('repo_scan')).toBeNull(); // elapsed 1000
    expect(tracker.canReadSource('repo_scan')).toBeNull(); // elapsed 2000
    const stop = tracker.canReadSource('repo_scan'); // elapsed 3000
    expect(stop?.rule).toBe('max_duration');
    expect(stop?.global).toBe(true);
  });

  it('caps a single source class without stopping the pass', () => {
    const tracker = createBudgetTracker(
      { maxSources: 10, maxSourcesPerKind: { web_search: 1 } },
      steppingClock(),
    );
    expect(tracker.canReadSource('web_search')).toBeNull();
    tracker.noteSourceRead('web_search');

    const stop = tracker.canReadSource('web_search');
    expect(stop?.rule).toBe('max_sources_per_kind');
    expect(stop?.global).toBe(false);
    // Other classes continue.
    expect(tracker.canReadSource('repo_scan')).toBeNull();
  });

  it('records each distinct stop once', () => {
    const tracker = createBudgetTracker({ maxSources: 0 }, steppingClock());
    tracker.canReadSource('repo_scan');
    tracker.canReadSource('uploaded_prd');
    tracker.canReadSource('repo_scan');
    expect(tracker.stops).toHaveLength(1);
    expect(tracker.stops[0].rule).toBe('max_sources');
  });
});
