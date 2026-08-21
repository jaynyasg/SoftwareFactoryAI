/**
 * Adapter failure normalization: the retryable / waitable / terminal split and
 * the best-effort "when does the limit reset" extraction that feeds the worker
 * runner's wait-and-retry loop for exhausted usage windows.
 */
import { describe, expect, it } from 'vitest';
import {
  AdapterError,
  isRetryableAdapterError,
  isTerminalAdapterError,
  isWaitableAdapterError,
  normalizeAdapterError,
  parseRetryDelayMs,
} from '../../src/index';

describe('adapter error classes', () => {
  it('usage_limited is waitable, not retryable, not terminal', () => {
    expect(isWaitableAdapterError('usage_limited')).toBe(true);
    expect(isRetryableAdapterError('usage_limited')).toBe(false);
    expect(isTerminalAdapterError('usage_limited')).toBe(false);
  });

  it('rate_limited stays retryable and setup failures stay terminal', () => {
    expect(isRetryableAdapterError('rate_limited')).toBe(true);
    expect(isWaitableAdapterError('rate_limited')).toBe(false);
    for (const kind of ['unavailable', 'unauthenticated', 'tool_denied', 'cancelled'] as const) {
      expect(isTerminalAdapterError(kind)).toBe(true);
      expect(isWaitableAdapterError(kind)).toBe(false);
    }
  });

  it('classifies real CLI usage-limit wordings as usage_limited', () => {
    for (const message of [
      'usage limit reached',
      "You've hit your usage limit.",
      '5-hour limit reached ∙ resets 3am',
      'weekly limit exceeded',
      'insufficient_quota',
    ]) {
      expect(normalizeAdapterError(message).kind).toBe('usage_limited');
    }
  });
});

describe('parseRetryDelayMs', () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);

  it('parses the Claude CLI trailing epoch form (seconds and ms)', () => {
    const resetSec = Math.floor(now / 1000) + 3600;
    expect(parseRetryDelayMs(`Claude AI usage limit reached|${resetSec}`, now)).toBe(3_600_000);
    const resetMs = now + 120_000;
    expect(parseRetryDelayMs(`usage limit reached|${resetMs}`, now)).toBe(120_000);
    // A reset in the past is useless — no hint beats a negative sleep.
    const past = Math.floor(now / 1000) - 60;
    expect(parseRetryDelayMs(`usage limit reached|${past}`, now)).toBeUndefined();
  });

  it('parses retry-after seconds', () => {
    expect(parseRetryDelayMs('429 too many requests, retry after 90', now)).toBe(90_000);
    expect(parseRetryDelayMs('Retry-After: 30', now)).toBe(30_000);
  });

  it('parses "try again in" / "resets in" durations', () => {
    expect(parseRetryDelayMs('You hit your usage limit. Try again in 2 hours.', now)).toBe(
      7_200_000,
    );
    expect(parseRetryDelayMs('quota exhausted, resets in 45 minutes', now)).toBe(2_700_000);
    expect(parseRetryDelayMs('rate limited — try again in 1 hour 30 minutes', now)).toBe(
      5_400_000,
    );
    expect(parseRetryDelayMs('available in 90 seconds', now)).toBe(90_000);
  });

  it('returns undefined when nothing parses', () => {
    expect(parseRetryDelayMs('usage limit reached', now)).toBeUndefined();
    expect(parseRetryDelayMs('some unrelated failure', now)).toBeUndefined();
  });
});

describe('normalizeAdapterError retryAfterMs enrichment', () => {
  it('attaches the parsed reset hint to usage/rate-limit errors', () => {
    const usage = normalizeAdapterError('usage limit reached. Try again in 2 hours.');
    expect(usage.kind).toBe('usage_limited');
    expect(usage.retryAfterMs).toBe(7_200_000);

    const rate = normalizeAdapterError('429 too many requests, retry after 15');
    expect(rate.kind).toBe('rate_limited');
    expect(rate.retryAfterMs).toBe(15_000);
  });

  it('never overrides an explicitly provided retryAfterMs', () => {
    const error = normalizeAdapterError('usage limit reached. Try again in 2 hours.', {
      retryAfterMs: 1_000,
    });
    expect(error.retryAfterMs).toBe(1_000);
  });

  it('leaves errors without a hint untouched', () => {
    const error = normalizeAdapterError('usage limit reached');
    expect(error.kind).toBe('usage_limited');
    expect(error.retryAfterMs).toBeUndefined();
    expect(AdapterError.usageLimited('x').retryAfterMs).toBeUndefined();
  });
});
