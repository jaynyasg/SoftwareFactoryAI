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

/* U6 — Sandbox, dependency policy, quality gates, local preview */

// Sandbox contract + policy enforcement + Docker/local-fallback selection.
export * from './sandbox/sandbox';
// Docker/WSL2-backed sandbox implementation.
export * from './sandbox/docker-sandbox';
// Reduced-trust host-local fallback sandbox implementation.
export * from './sandbox/local-fallback';
// Allow-list + risk-aware review for dependency additions (pure).
export * from './sandbox/dependency-policy';

// Shared gate contracts + command-backed gate builder.
export * from './gates/command-gate';
// Individual gates: lint, typecheck, unit test, secret scan, preview health.
export * from './gates/lint-gate';
export * from './gates/typecheck-gate';
export * from './gates/test-gate';
export * from './gates/secret-scan-gate';
export * from './gates/preview-health-gate';
// Blocking gate orchestrator (ordered, bounded retry, structured failure context).
export * from './gates/gate-runner';

// Local preview server: start command, poll health, expose URL only when ready.
export * from './preview/preview-server';

/* U9 — Package provenance, Git destination, and Render deployment */

// Render the human-facing handoff markdown (pure).
export * from './package/handoff-writer';
// Package a generated app as a valid git repo (init/add/commit) + package.created.
export * from './package/repo-packager';
// Resolve the git destination (user vs temporary vs setup-required) + push client.
export * from './git/git-destination';
// Generate + validate the Render blueprint (render.yaml).
export * from './deploy/render/render-config';
// Render API client behind an injectable HTTP transport.
export * from './deploy/render/render-client';
// Render deploy orchestrator: preconditions -> trigger -> health -> hosted URL.
export * from './deploy/render/render-deployer';
