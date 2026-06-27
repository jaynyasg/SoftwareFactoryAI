/**
 * @software-factory/core — shared contracts for the factory runtime.
 *
 * This barrel is the single public entry point for the package. Later units
 * populate it:
 *   U2  events + replay projections
 *   U3  security (operator token, command guard, review policy)
 *   U4  supervisor, ticket DAG, genome, context compiler
 *   U5  execution adapters
 *   U9  provenance + artifact confidence
 *   U11 observability (metrics, failure registry, diagnostics)
 */

/** Semantic version of the core contract surface. */
export const CORE_CONTRACT_VERSION = '0.1.0';

/** Stable package identifier embedded in provenance and ledger metadata. */
export const CORE_PACKAGE_NAME = '@software-factory/core' as const;

/* U2 — Ledger events, storage, and replay projections */

// Event contract: envelope, families, payloads, type guards.
export * from './events/event-types';
// Per-run monotonic sequence assignment.
export * from './events/sequence';
// Append-only store interface + in-memory and filesystem implementations.
export * from './events/event-store';
// Ergonomic append + ordered-read facades.
export * from './events/event-writer';
export * from './events/event-reader';

// Replay projections (pure events[] -> state).
export * from './projections/run-projection';
export * from './projections/ticket-projection';
export * from './projections/artifact-projection';
export * from './projections/operator-projection';
