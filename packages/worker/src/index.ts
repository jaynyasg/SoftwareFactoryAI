import { CORE_PACKAGE_NAME } from '@software-factory/core';

/** Stable package identifier for the worker runtime. */
export const WORKER_PACKAGE_NAME = '@software-factory/worker' as const;

/**
 * The worker runtime (scheduler, execution adapters, sandbox, gates, packaging,
 * deploy) builds on the core contract surface. Referencing it here also proves
 * cross-package resolution is wired correctly from the scaffold onward.
 */
export const WORKER_BUILDS_ON = CORE_PACKAGE_NAME;
