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
