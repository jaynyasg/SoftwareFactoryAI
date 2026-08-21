/**
 * Ticket dependency graph: build, topologically order, and query a DAG from a
 * set of nodes carrying `dependsOn` edges.
 *
 * Construction validates the graph eagerly and FAILS FAST with explicit, typed
 * errors — a missing dependency, a duplicate id, or a cycle never produces a
 * partial graph and never hangs. `readyTickets` is the scheduler-facing query
 * (reused by U5) that returns the nodes whose dependencies are all complete.
 */

/** The minimal shape the DAG needs: an id and its dependency ids. */
export interface DagNode {
  readonly id: string;
  readonly dependsOn: readonly string[];
}

/** A validated dependency graph over `TNode`. */
export interface TicketDag<TNode extends DagNode = DagNode> {
  /** Nodes in their original input order. */
  readonly nodes: readonly TNode[];
  /** Node lookup by id. */
  readonly byId: ReadonlyMap<string, TNode>;
  /** Topologically sorted ids (every dependency precedes its dependents). */
  readonly order: readonly string[];
  /** Deduplicated direct dependencies for each node id. */
  readonly dependencies: ReadonlyMap<string, readonly string[]>;
  /** Direct dependents (reverse edges) for each node id. */
  readonly dependents: ReadonlyMap<string, readonly string[]>;
}

/** Thrown when two nodes share an id. */
export class DuplicateTicketIdError extends Error {
  readonly code = 'duplicate_ticket_id';
  constructor(readonly ticketId: string) {
    super(`Duplicate ticket id in DAG: ${ticketId}.`);
    this.name = 'DuplicateTicketIdError';
  }
}

/** Thrown when a node depends on an id that is not in the graph. */
export class MissingDependencyError extends Error {
  readonly code = 'missing_dependency';
  constructor(
    readonly ticketId: string,
    readonly missingId: string,
  ) {
    super(`Ticket ${ticketId} depends on unknown ticket ${missingId}.`);
    this.name = 'MissingDependencyError';
  }
}

/** Thrown when the dependency edges form a cycle. */
export class DependencyCycleError extends Error {
  readonly code = 'dependency_cycle';
  constructor(readonly cycle: readonly string[]) {
    super(`Dependency cycle detected: ${cycle.join(' -> ')}.`);
    this.name = 'DependencyCycleError';
  }
}

function dedupe(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** Locate one cycle among nodes that survived Kahn's algorithm. */
function findCycle(
  candidateIds: readonly string[],
  dependencies: ReadonlyMap<string, readonly string[]>,
): string[] {
  type Mark = 'unvisited' | 'in_stack' | 'done';
  const state = new Map<string, Mark>();
  const stack: string[] = [];
  let cycle: string[] = [];

  const visit = (id: string): boolean => {
    state.set(id, 'in_stack');
    stack.push(id);
    for (const dep of dependencies.get(id) ?? []) {
      const mark = state.get(dep) ?? 'unvisited';
      if (mark === 'in_stack') {
        const start = stack.indexOf(dep);
        cycle = [...stack.slice(start), dep];
        return true;
      }
      if (mark === 'unvisited' && visit(dep)) {
        return true;
      }
    }
    stack.pop();
    state.set(id, 'done');
    return false;
  };

  for (const id of candidateIds) {
    if ((state.get(id) ?? 'unvisited') === 'unvisited' && visit(id)) {
      break;
    }
  }
  return cycle;
}

/**
 * Build a validated DAG. Throws `DuplicateTicketIdError`,
 * `MissingDependencyError`, or `DependencyCycleError` on an invalid graph.
 * Deterministic: ties in the topological order are broken by input order.
 */
export function buildTicketDag<TNode extends DagNode>(nodes: readonly TNode[]): TicketDag<TNode> {
  const byId = new Map<string, TNode>();
  for (const node of nodes) {
    if (byId.has(node.id)) {
      throw new DuplicateTicketIdError(node.id);
    }
    byId.set(node.id, node);
  }

  const dependencies = new Map<string, readonly string[]>();
  const dependents = new Map<string, string[]>();
  for (const node of nodes) {
    dependents.set(node.id, []);
  }
  for (const node of nodes) {
    const deps = dedupe(node.dependsOn);
    for (const dep of deps) {
      if (!byId.has(dep)) {
        throw new MissingDependencyError(node.id, dep);
      }
    }
    dependencies.set(node.id, deps);
  }
  for (const node of nodes) {
    for (const dep of dependencies.get(node.id) ?? []) {
      dependents.get(dep)?.push(node.id);
    }
  }

  // Kahn's algorithm; the queue preserves input order for determinism.
  const inDegree = new Map<string, number>();
  for (const node of nodes) {
    inDegree.set(node.id, (dependencies.get(node.id) ?? []).length);
  }
  const queue: string[] = [];
  for (const node of nodes) {
    if ((inDegree.get(node.id) ?? 0) === 0) {
      queue.push(node.id);
    }
  }
  const order: string[] = [];
  let cursor = 0;
  while (cursor < queue.length) {
    const id = queue[cursor];
    cursor += 1;
    order.push(id);
    for (const dependent of dependents.get(id) ?? []) {
      const next = (inDegree.get(dependent) ?? 0) - 1;
      inDegree.set(dependent, next);
      if (next === 0) {
        queue.push(dependent);
      }
    }
  }

  if (order.length !== nodes.length) {
    const remaining = nodes.map((node) => node.id).filter((id) => !order.includes(id));
    throw new DependencyCycleError(findCycle(remaining, dependencies));
  }

  const frozenDependents = new Map<string, readonly string[]>();
  for (const [id, list] of dependents) {
    frozenDependents.set(id, list);
  }

  return {
    nodes,
    byId,
    order,
    dependencies,
    dependents: frozenDependents,
  };
}

/**
 * Return the nodes that are ready to run: not yet complete, and with every
 * dependency present in `completedIds`. Results are in topological order.
 */
export function readyTickets<TNode extends DagNode>(
  dag: TicketDag<TNode>,
  completedIds: Iterable<string>,
): TNode[] {
  const done = new Set(completedIds);
  const ready: TNode[] = [];
  for (const id of dag.order) {
    if (done.has(id)) {
      continue;
    }
    const deps = dag.dependencies.get(id) ?? [];
    if (deps.every((dep) => done.has(dep))) {
      const node = dag.byId.get(id);
      if (node !== undefined) {
        ready.push(node);
      }
    }
  }
  return ready;
}
