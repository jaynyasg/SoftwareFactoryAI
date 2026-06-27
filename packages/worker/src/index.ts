import { CORE_PACKAGE_NAME } from '@software-factory/core';

/** Stable package identifier for the worker runtime. */
export const WORKER_PACKAGE_NAME = '@software-factory/worker' as const;

/**
 * The worker runtime (scheduler, execution adapters, sandbox, gates, packaging,
 * deploy) builds on the core contract surface. Referencing it here also proves
 * cross-package resolution is wired correctly from the scaffold onward.
 */
export const WORKER_BUILDS_ON = CORE_PACKAGE_NAME;

/* U5 — Worker runner + adaptive 10-worker scheduling */

// Pure adaptive-capacity computation (min across constraints + bounding reason).
export * from './runner/capacity';
// Ticket write scopes + conflict detection/tracking (serialize overlaps).
export * from './runner/write-scope';
// Composable AbortController-based cancellation (run-level + per-ticket).
export * from './runner/cancellation';
// Single-ticket runner: context compile, streaming, bounded retry, ledger.
export * from './runner/worker-runner';
// Adaptive scheduler: ready tickets -> concurrent workers up to capacity.
export * from './runner/scheduler';
