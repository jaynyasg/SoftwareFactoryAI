import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  EVENT_TYPES,
  FAILURE_EVENT_TYPES,
  FAILURE_REGISTRY,
  isFailureEventType,
  listFailures,
  lookupFailure,
  type EventSeverity,
  type FailureEventType,
} from '../../src/index';

/**
 * The failure families the unit plan requires the registry to cover, taken
 * verbatim from the event taxonomy. The registry must be a SUPERSET of this.
 */
const REQUIRED_FAILURE_FAMILIES: readonly FailureEventType[] = [
  'adapter.error',
  'adapter.auth_failed',
  'adapter.setup_required',
  'sandbox.error',
  'sandbox.fallback',
  'gate.failed',
  'deploy.config_invalid',
  'deploy.provider_failed',
  'deploy.migration_failed',
  'deploy.health_failed',
  'deploy.setup_required',
  'security.block',
  'security.command_rejected',
  'worker.failed',
  'worker.retry',
  'worker.cancelled',
  'ticket.dead_lettered',
  'run.failed',
];

const VALID_SEVERITIES: readonly EventSeverity[] = ['info', 'success', 'warn', 'error', 'critical'];

/** Substrings that mark a failure-shaped event type in the taxonomy. */
const FAILURE_NAME_RE = /(fail|error|reject|block|invalid|cancel|dead_letter|retry|fallback|setup_required)/;

const runbook = readFileSync(
  new URL('../../../../docs/runbooks/failure-taxonomy.md', import.meta.url),
  'utf8',
);

describe('failure registry — exhaustiveness', () => {
  it('covers every required failure family from the plan', () => {
    for (const type of REQUIRED_FAILURE_FAMILIES) {
      expect(FAILURE_REGISTRY[type], `missing registry entry for ${type}`).toBeDefined();
    }
  });

  it('covers every failure-shaped event type in the taxonomy (future-proof)', () => {
    const shaped = EVENT_TYPES.filter((type) => FAILURE_NAME_RE.test(type)).sort();
    const registered = [...FAILURE_EVENT_TYPES].sort();
    // Any new failure-shaped event family must be added to the registry.
    expect(registered).toEqual(shaped);
  });

  it('has exactly one entry per pinned failure type, keyed by type', () => {
    const entries = listFailures();
    expect(entries).toHaveLength(FAILURE_EVENT_TYPES.length);
    for (const type of FAILURE_EVENT_TYPES) {
      expect(FAILURE_REGISTRY[type].type).toBe(type);
    }
    // No duplicates.
    expect(new Set(FAILURE_EVENT_TYPES).size).toBe(FAILURE_EVENT_TYPES.length);
  });
});

describe('failure registry — entry shape + invariants', () => {
  it('every entry has valid severity, boolean blocking/retryable, and non-empty rescue + runbook', () => {
    for (const entry of listFailures()) {
      expect(VALID_SEVERITIES).toContain(entry.severity);
      expect(typeof entry.blocking).toBe('boolean');
      expect(typeof entry.retryable).toBe('boolean');
      expect(entry.rescueAction.length).toBeGreaterThan(0);
      expect(entry.runbook).toContain('failure-taxonomy.md');
      expect(entry.title.length).toBeGreaterThan(0);
    }
  });

  it('maps severity / blocking / retryable correctly per representative class', () => {
    // Security boundary blocks are the loudest and never retryable.
    expect(FAILURE_REGISTRY['security.block']).toMatchObject({
      severity: 'critical',
      blocking: true,
      retryable: false,
    });
    expect(FAILURE_REGISTRY['security.command_rejected']).toMatchObject({
      severity: 'critical',
      blocking: true,
      retryable: false,
    });
    // A gate failure blocks and a bounded retry can recover.
    expect(FAILURE_REGISTRY['gate.failed']).toMatchObject({
      severity: 'error',
      blocking: true,
      retryable: true,
    });
    // Sandbox fallback is a non-blocking reduced-trust degrade, not retryable.
    expect(FAILURE_REGISTRY['sandbox.fallback']).toMatchObject({
      severity: 'warn',
      blocking: false,
      retryable: false,
    });
    // Auth/setup require human action — blocking, not blind-retryable.
    expect(FAILURE_REGISTRY['adapter.auth_failed']).toMatchObject({
      blocking: true,
      retryable: false,
    });
    expect(FAILURE_REGISTRY['adapter.setup_required']).toMatchObject({
      blocking: true,
      retryable: false,
    });
    expect(FAILURE_REGISTRY['deploy.setup_required']).toMatchObject({
      severity: 'warn',
      blocking: true,
      retryable: false,
    });
    // Deploy/provider/migration/health failures are retryable after a fix.
    for (const type of [
      'deploy.provider_failed',
      'deploy.migration_failed',
      'deploy.health_failed',
      'deploy.config_invalid',
    ] as const) {
      expect(FAILURE_REGISTRY[type].retryable, `${type} should be retryable`).toBe(true);
      expect(FAILURE_REGISTRY[type].blocking).toBe(true);
    }
    // worker.retry is a transient, non-blocking, retryable signal.
    expect(FAILURE_REGISTRY['worker.retry']).toMatchObject({
      blocking: false,
      retryable: true,
    });
    // A dead-lettered ticket exhausted its budget: blocking, not retryable.
    expect(FAILURE_REGISTRY['ticket.dead_lettered']).toMatchObject({
      severity: 'error',
      blocking: true,
      retryable: false,
    });
  });
});

describe('failure registry — lookups', () => {
  it('lookupFailure returns entries for failure types and undefined otherwise', () => {
    expect(lookupFailure('gate.failed')?.type).toBe('gate.failed');
    expect(lookupFailure('run.completed')).toBeUndefined();
    expect(lookupFailure('not-an-event')).toBeUndefined();
  });

  it('isFailureEventType narrows correctly', () => {
    expect(isFailureEventType('deploy.provider_failed')).toBe(true);
    expect(isFailureEventType('gate.passed')).toBe(false);
    expect(isFailureEventType(42)).toBe(false);
  });
});

describe('failure registry — runbook stays in sync', () => {
  it('the failure-taxonomy runbook has a heading for every registry entry', () => {
    for (const type of FAILURE_EVENT_TYPES) {
      expect(runbook, `runbook missing "### ${type}" heading`).toContain(`### ${type}`);
    }
  });

  it('the runbook has no failure headings that are not in the registry', () => {
    const headings = [...runbook.matchAll(/^###\s+([a-z]+\.[a-z_]+)\s*$/gm)].map((m) => m[1]);
    const registered = new Set<string>(FAILURE_EVENT_TYPES);
    for (const heading of headings) {
      expect(registered.has(heading), `runbook documents unregistered failure "${heading}"`).toBe(
        true,
      );
    }
    // And every registered type is present as a heading (1:1).
    expect(new Set(headings)).toEqual(registered);
  });
});
