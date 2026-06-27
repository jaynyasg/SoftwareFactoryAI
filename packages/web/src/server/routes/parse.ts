/**
 * Shared request-body coercion helpers for the mutating run/review routes.
 *
 * Kept tiny and pure so every route validates inbound JSON identically (a body
 * may be any unknown shape; these narrow it without trusting it).
 */
import type { ReviewMode } from '@software-factory/core';

/** Narrow an unknown body to a record (or an empty record when it is not one). */
export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** A non-empty string, else `undefined`. */
export function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** A finite number, else `undefined`. */
export function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** A valid review mode, else `undefined`. */
export function reviewMode(value: unknown): ReviewMode | undefined {
  return value === 'autonomous' || value === 'human' ? value : undefined;
}
