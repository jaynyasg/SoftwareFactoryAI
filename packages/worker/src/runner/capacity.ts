/**
 * Pure adaptive-capacity computation for the worker scheduler.
 *
 * Effective concurrency is the minimum across every constraint:
 *   min(readyTickets, requestedCap in [1,20], adapterCapacity, sandboxCapacity,
 *       resourceBudget, writeScopeAvailable, reviewPolicyLimit)
 *
 * The result also explains WHY capacity landed where it did (`boundBy`) and, more
 * importantly, whether a *system* constraint throttled us below what we asked
 * for and could otherwise serve (`systemThrottled`). The scheduler emits an
 * `adapter.capacity_changed` event only when `systemThrottled` is true — running
 * fewer workers simply because fewer tickets are ready (demand) or because the
 * operator asked for fewer is normal, not a capacity reduction worth alerting on.
 *
 * This module is pure: no clocks, randomness, or I/O.
 */

/** Lower/upper bounds for the operator-requested worker cap. */
export const MIN_WORKER_CAP = 1;
export const MAX_WORKER_CAP = 20;

/** The named constraints that can bound effective capacity. */
export type CapacityConstraintName =
  | 'ready_tickets'
  | 'requested_cap'
  | 'adapter_capacity'
  | 'sandbox_capacity'
  | 'resource_budget'
  | 'write_scope'
  | 'review_policy';

/** The raw inputs to a capacity computation (all counts, >= 0). */
export interface CapacityConstraints {
  /** Tickets ready to run right now (demand), including any already running. */
  readonly readyTickets: number;
  /** Operator-requested cap; clamped to [MIN_WORKER_CAP, MAX_WORKER_CAP]. */
  readonly requestedCap: number;
  /** Concurrent tasks the selected adapter can sustain. */
  readonly adapterCapacity: number;
  /** Concurrent sandboxes available (source: U6; defaults non-binding). */
  readonly sandboxCapacity: number;
  /** CPU/memory budget expressed as a worker count. */
  readonly resourceBudget: number;
  /** Free write-scope slots (coarse; structural conflicts also serialize). */
  readonly writeScopeAvailable: number;
  /** Concurrency the review policy permits. */
  readonly reviewPolicyLimit: number;
}

/** The computed capacity plus the reason it was bounded. */
export interface EffectiveCapacity {
  /** Workers that may run concurrently right now (>= 0). */
  readonly capacity: number;
  /** The operator-requested cap after clamping to [1, 20]. */
  readonly requested: number;
  /** The constraint that determined `capacity`. */
  readonly boundBy: CapacityConstraintName;
  /**
   * `true` when a SYSTEM constraint (adapter/sandbox/resource/write-scope/review)
   * — not demand and not the requested cap — held capacity below both the
   * requested cap and the available demand. This gates the capacity-reduction event.
   */
  readonly systemThrottled: boolean;
  /** Human-facing reason; present iff `systemThrottled`. */
  readonly reason?: string;
}

const LABELS: Readonly<Record<CapacityConstraintName, string>> = {
  ready_tickets: 'ready tickets',
  requested_cap: 'requested worker cap',
  adapter_capacity: 'adapter capacity',
  sandbox_capacity: 'sandbox capacity',
  resource_budget: 'resource budget',
  write_scope: 'write-scope availability',
  review_policy: 'review policy limit',
};

/** The system constraints, in the deterministic precedence used for tie-breaks. */
const SYSTEM_CONSTRAINTS: readonly CapacityConstraintName[] = [
  'adapter_capacity',
  'sandbox_capacity',
  'resource_budget',
  'write_scope',
  'review_policy',
];

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  const truncated = Math.trunc(value);
  if (truncated < min) {
    return min;
  }
  if (truncated > max) {
    return max;
  }
  return truncated;
}

function nonNegative(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.trunc(value);
}

/**
 * Compute effective concurrency and the binding reason. Deterministic: ties
 * between equally-small system constraints resolve by `SYSTEM_CONSTRAINTS` order.
 */
export function computeEffectiveCapacity(constraints: CapacityConstraints): EffectiveCapacity {
  const requested = clamp(constraints.requestedCap, MIN_WORKER_CAP, MAX_WORKER_CAP);
  const demand = nonNegative(constraints.readyTickets);

  const systemValues: Readonly<Record<CapacityConstraintName, number>> = {
    ready_tickets: demand,
    requested_cap: requested,
    adapter_capacity: nonNegative(constraints.adapterCapacity),
    sandbox_capacity: nonNegative(constraints.sandboxCapacity),
    resource_budget: nonNegative(constraints.resourceBudget),
    write_scope: nonNegative(constraints.writeScopeAvailable),
    review_policy: nonNegative(constraints.reviewPolicyLimit),
  };

  // Smallest system constraint (deterministic tie-break by precedence order).
  let minSystemName: CapacityConstraintName = SYSTEM_CONSTRAINTS[0];
  let minSystemValue = systemValues[minSystemName];
  for (const name of SYSTEM_CONSTRAINTS) {
    if (systemValues[name] < minSystemValue) {
      minSystemValue = systemValues[name];
      minSystemName = name;
    }
  }

  const capacity = Math.max(0, Math.min(requested, demand, minSystemValue));

  // A system constraint throttled us only if it is strictly below BOTH the
  // requested cap and the available demand (otherwise demand/requested bound it).
  const systemThrottled = minSystemValue < requested && minSystemValue < demand;

  if (systemThrottled) {
    return {
      capacity,
      requested,
      boundBy: minSystemName,
      systemThrottled: true,
      reason: `${capitalize(LABELS[minSystemName])} (${minSystemValue}) is below the requested cap (${requested}).`,
    };
  }

  const boundBy: CapacityConstraintName = demand < requested ? 'ready_tickets' : 'requested_cap';
  return { capacity, requested, boundBy, systemThrottled: false };
}

function capitalize(text: string): string {
  return text.length === 0 ? text : `${text[0].toUpperCase()}${text.slice(1)}`;
}
