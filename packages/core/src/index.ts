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

/* U3 — Security: operator token, command guard, review policy */

// Loopback operator token/session: generation, constant-time verify, provider.
export * from './security/operator-token';
// Pure command guard for mutating actions (token/origin/CSRF/stale-version).
export * from './security/command-guard';
// Risk-tier review policy: human-mode approvals + no-stop autonomous handling.
export * from './security/review-policy';

/* U4 — Supervisor, ticket DAG, genome, and lightweight context compiler */

// Prompt/PRD intake -> normalized, intent-tagged RunRequest.
export * from './supervisor/run-request';
// Risk-tier computation from work signals.
export * from './supervisor/risk-tier';
// Deterministic planner: planRun (pure) + emitPlan (ledger writer).
export * from './supervisor/planner';
// Ticket dependency graph: build, topo order, readyTickets, cycle/missing errors.
export * from './supervisor/ticket-dag';

// Genome module contract types + runtime validator.
export * from './genome/module-contract';
// Module registry: in-memory build + load/validate from a genome directory.
export * from './genome/module-registry';
// Lightweight worker-context compiler (resolved inputs + allow-listed tools).
export * from './genome/context-compiler';

/* U5 — Execution adapters: one contract, normalized errors, BYO/CLI + API */

// The shared ExecutionAdapter contract + CommandRunner abstraction.
export * from './adapters/execution-adapter';
// Normalized, discriminated adapter failures + classification helpers.
export * from './adapters/adapter-errors';
// Default Node child_process-backed CommandRunner (never required in tests).
export * from './adapters/node-command-runner';
// Local/BYO CLI adapters behind the shared contract.
export * from './adapters/codex-cli-adapter';
export * from './adapters/claude-code-cli-adapter';
// Hosted/server-side execution stub behind the same contract.
export * from './adapters/api-adapter';

/* U9 — Provenance bundle + artifact confidence */

// Pure provenance-bundle assembly + completeness scoring + ledger derivations.
export * from './provenance/provenance-bundle';
// Pure artifact confidence: blended score + factor breakdown the U8 UI renders.
export * from './provenance/artifact-confidence';

/* U11 — Operator observability: metrics, failure registry, run diagnostics */

// Pure operator metrics (event/projection lag, capacity, queue, adapter, sandbox,
// gates, preview, deploy, hosted health) derived from events + projections.
export * from './observability/metrics';
// Exhaustive failure-class registry: severity/blocking/retryable/rescue + lookups.
export * from './observability/failure-registry';
// Per-run diagnostics: projection gaps, stalls, blocked-by-failed-dependency, and
// active failures joined to their failure-registry rescue actions.
export * from './observability/run-diagnostics';
