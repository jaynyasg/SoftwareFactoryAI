import { describe, expect, it } from 'vitest';
import {
  DependencyCycleError,
  DuplicateTicketIdError,
  MissingDependencyError,
  buildTicketDag,
  readyTickets,
  type DagNode,
} from '../../src/index';

function node(id: string, ...dependsOn: string[]): DagNode {
  return { id, dependsOn };
}

describe('buildTicketDag', () => {
  it('produces a topological order with dependencies before dependents', () => {
    const dag = buildTicketDag([node('a'), node('b', 'a'), node('c', 'a'), node('d', 'b', 'c')]);

    const index = (id: string) => dag.order.indexOf(id);
    expect(index('a')).toBeLessThan(index('b'));
    expect(index('a')).toBeLessThan(index('c'));
    expect(index('b')).toBeLessThan(index('d'));
    expect(index('c')).toBeLessThan(index('d'));
    expect(dag.order).toHaveLength(4);
  });

  it('records direct dependents (reverse edges)', () => {
    const dag = buildTicketDag([node('a'), node('b', 'a'), node('c', 'a')]);
    expect([...(dag.dependents.get('a') ?? [])].sort()).toEqual(['b', 'c']);
    expect(dag.dependents.get('b')).toEqual([]);
  });

  it('deduplicates repeated dependency edges', () => {
    const dag = buildTicketDag([node('a'), node('b', 'a', 'a')]);
    expect(dag.dependencies.get('b')).toEqual(['a']);
    expect(dag.order).toEqual(['a', 'b']);
  });

  it('throws DuplicateTicketIdError on a repeated id', () => {
    expect(() => buildTicketDag([node('a'), node('a')])).toThrow(DuplicateTicketIdError);
  });

  it('throws MissingDependencyError when a dependency id is unknown', () => {
    let caught: unknown;
    try {
      buildTicketDag([node('a', 'ghost')]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MissingDependencyError);
    expect((caught as MissingDependencyError).missingId).toBe('ghost');
    expect((caught as MissingDependencyError).ticketId).toBe('a');
  });

  it('detects a cycle explicitly without hanging', () => {
    let caught: unknown;
    try {
      buildTicketDag([node('a', 'c'), node('b', 'a'), node('c', 'b')]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DependencyCycleError);
    const cycle = (caught as DependencyCycleError).cycle;
    expect(cycle.length).toBeGreaterThan(0);
    // The reported path starts and ends on the same node.
    expect(cycle[0]).toBe(cycle[cycle.length - 1]);
  });

  it('detects a self-dependency as a cycle', () => {
    expect(() => buildTicketDag([node('a', 'a')])).toThrow(DependencyCycleError);
  });
});

describe('readyTickets', () => {
  const dag = buildTicketDag([
    node('scaffold'),
    node('model', 'scaffold'),
    node('api', 'model'),
    node('ui', 'api'),
  ]);

  it('returns only nodes with no dependencies when nothing is complete', () => {
    expect(readyTickets(dag, []).map((n) => n.id)).toEqual(['scaffold']);
  });

  it('unlocks a node once all its dependencies are complete', () => {
    expect(readyTickets(dag, ['scaffold']).map((n) => n.id)).toEqual(['model']);
    expect(readyTickets(dag, ['scaffold', 'model']).map((n) => n.id)).toEqual(['api']);
  });

  it('never returns an already-completed node', () => {
    const ready = readyTickets(dag, ['scaffold', 'model', 'api', 'ui']);
    expect(ready).toEqual([]);
  });

  it('returns ready nodes in topological order', () => {
    const branched = buildTicketDag([node('root'), node('left', 'root'), node('right', 'root')]);
    expect(readyTickets(branched, ['root']).map((n) => n.id)).toEqual(['left', 'right']);
  });
});
