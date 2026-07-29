/**
 * Pure U5 derivation tests: the stage pipeline (`deriveCurrentStage` /
 * `deriveStageActivities`) and the truthful status headline
 * (`deriveStatusHeadline` / `deriveFactoryNeedsYou`). Everything folds from
 * REAL core/server projections of fixture (or hand-built, validator-shaped)
 * ledgers — never hand-invented view models — so a lying headline fails here
 * before it can reach the floor.
 */
import { describe, expect, it } from 'vitest';
import type { FactoryEvent } from '@software-factory/core';
import {
  buildCreatedRunEvents,
  buildFullFactoryRunEvents,
  buildMarketplaceRunEvents,
} from '../../../../tests/fixtures/marketplace-run';
import { aggregateFromEvents } from '../_helpers/aggregate';
import {
  appendEvents,
  buildEvents,
  buildRetryPendingEvents,
  buildRetryResolvedEvents,
} from '../_helpers/events';
import {
  deriveCurrentStage,
  deriveFactoryNeedsYou,
  deriveStageActivities,
  deriveStatusHeadline,
} from '../../src/lib/run-view';
import type { BlueprintInputs, HeadlineInputs } from '../../src/lib/run-view';
import type { InterventionItem, RunAggregate } from '../../src/lib/types';

function inputsOf(aggregate: RunAggregate): BlueprintInputs {
  return {
    run: aggregate.run,
    tickets: aggregate.tickets,
    research: aggregate.research,
    preflight: aggregate.preflight,
    executionJob: aggregate.executionJob,
    gates: aggregate.gates,
    repairs: aggregate.repairs,
    packageView: aggregate.packageView,
    deploy: aggregate.deploy,
    operator: aggregate.operator,
  };
}

function headlineInputsOf(aggregate: RunAggregate): HeadlineInputs {
  return {
    ...inputsOf(aggregate),
    reviews: aggregate.reviews,
    interventions: aggregate.interventions,
  };
}

function stageAt(events: readonly FactoryEvent[], runId: string) {
  return deriveCurrentStage(inputsOf(aggregateFromEvents(events, runId)));
}

describe('deriveCurrentStage (R2 stage pipeline)', () => {
  const runId = 'run-stage';

  it('moves through planning → queue → gates → deploy as events advance', () => {
    // Just created: the supervisor has not planned yet — planning is current.
    expect(stageAt(buildCreatedRunEvents(runId), runId)).toBe('planning');

    // Planned with tickets created but nothing started: the queue is waiting.
    const events = buildMarketplaceRunEvents(runId);
    const plannedIndex = events.findIndex((e) => e.type === 'run.planned');
    expect(plannedIndex).toBeGreaterThan(0);
    expect(stageAt(events.slice(0, plannedIndex + 1), runId)).toBe('queue');

    // First gate running (workers also active): gates is the furthest live work.
    const gateIndex = events.findIndex((e) => e.type === 'gate.started');
    expect(gateIndex).toBeGreaterThan(0);
    expect(stageAt(events.slice(0, gateIndex + 1), runId)).toBe('gates');

    // Full fixture: deploy setup blocks — the marker sits on deploy.
    expect(stageAt(buildFullFactoryRunEvents(runId), runId)).toBe('deploy');
  });

  it('keeps a retry inside the repair lane — never pipeline regression', () => {
    const events = appendEvents(buildRetryPendingEvents(runId), runId, [
      {
        type: 'repair.started',
        severity: 'warn',
        payload: { attempt: 1, gate: 'unit-test', reason: '2 tests failed' },
        ticketId: 't1',
      },
    ]);
    const inputs = inputsOf(aggregateFromEvents(events, runId));
    expect(deriveCurrentStage(inputs)).toBe('repair');
    // The earlier stages keep their own truthful activity — no regression.
    expect(deriveStageActivities(inputs).gates).toBe('blocked');
  });

  it('falls back to the furthest COMPLETED stage when nothing is live', () => {
    const events = buildEvents('run-done', [
      { type: 'run.created', payload: { prompt: 'Ship it' } },
      { type: 'run.planned', payload: { ticketCount: 0 } },
      { type: 'run.started', payload: {} },
      { type: 'gate.started', payload: { gate: 'lint' } },
      { type: 'gate.passed', payload: { gate: 'lint' }, severity: 'success' },
      {
        type: 'deploy.hosted_ready',
        payload: { url: 'https://app.example.com' },
        severity: 'success',
      },
      { type: 'run.completed', payload: { summary: 'done' }, severity: 'success' },
    ]);
    expect(stageAt(events, 'run-done')).toBe('deploy');
  });

  it('returns null only when no events reached any stage', () => {
    expect(stageAt([], 'run-empty')).toBeNull();
  });
});

describe('deriveStatusHeadline (R3/R5, AE4)', () => {
  const runId = 'run-headline';

  it('counts a paired failed-gate retry (intervention + stage review) as ONE decision', () => {
    const headline = deriveStatusHeadline(
      headlineInputsOf(aggregateFromEvents(buildRetryPendingEvents(runId), runId)),
    );
    expect(headline.needsYou).toBe(1);
    expect(headline.items).toHaveLength(1);
    expect(headline.items[0]).toMatchObject({ kind: 'intervention' });
    expect(headline.items[0].label).toMatch(/gates/);
    // The paired stage review is represented by the intervention item, so the
    // factory-wide count must not add it again on top of the queue's count.
    expect(headline.unpairedReviewCount).toBe(0);
    expect(headline.text).toBe('Gate "unit-test" failed.');
  });

  it('drops to the explicit idle state once the decision is resolved (AE4)', () => {
    const headline = deriveStatusHeadline(
      headlineInputsOf(aggregateFromEvents(buildRetryResolvedEvents(runId), runId)),
    );
    expect(headline.needsYou).toBe(0);
    expect(headline.items).toHaveLength(0);
    expect(headline.unpairedReviewCount).toBe(0);
  });

  it('counts a pending review with ZERO interventions (the union rule)', () => {
    // The base marketplace fixture has one pending high-risk review and no
    // intervention events at all — interventions alone would lie here.
    const aggregate = aggregateFromEvents(buildMarketplaceRunEvents(runId), runId);
    expect(aggregate.interventions).toHaveLength(0);
    const headline = deriveStatusHeadline(headlineInputsOf(aggregate));
    expect(headline.needsYou).toBe(1);
    expect(headline.items[0]).toMatchObject({ kind: 'review' });
    expect(headline.unpairedReviewCount).toBe(1);
  });

  it('names both decisions when a run has an intervention AND an unrelated review', () => {
    // Full fixture: one open deploy-setup intervention + one pending plain
    // risk-tier review (no stage — not paired with the intervention).
    const headline = deriveStatusHeadline(
      headlineInputsOf(aggregateFromEvents(buildFullFactoryRunEvents(runId), runId)),
    );
    expect(headline.needsYou).toBe(2);
    expect(headline.items.map((item) => item.kind)).toEqual(['intervention', 'review']);
    expect(headline.unpairedReviewCount).toBe(1);
    expect(headline.text).toBe('Deploy setup required.');
  });

  it('states terminal and paused run states in plain words', () => {
    const cancelled = buildEvents('run-c', [
      { type: 'run.created', payload: { prompt: 'x' } },
      { type: 'run.cancelled', payload: { reason: 'operator' }, severity: 'warn' },
    ]);
    expect(
      deriveStatusHeadline(headlineInputsOf(aggregateFromEvents(cancelled, 'run-c'))).text,
    ).toBe('Run cancelled — nothing is executing.');

    const hosted = buildEvents('run-h', [
      { type: 'run.created', payload: { prompt: 'x' } },
      { type: 'run.planned', payload: { ticketCount: 0 } },
      { type: 'run.started', payload: {} },
      { type: 'deploy.hosted_ready', payload: { url: 'https://a.example' }, severity: 'success' },
      { type: 'run.completed', payload: {}, severity: 'success' },
    ]);
    expect(deriveStatusHeadline(headlineInputsOf(aggregateFromEvents(hosted, 'run-h'))).text).toBe(
      'Run completed — hosted and healthy.',
    );

    const paused = buildEvents('run-p', [
      { type: 'run.created', payload: { prompt: 'x' } },
      { type: 'run.planned', payload: { ticketCount: 0 } },
      { type: 'run.started', payload: {} },
      { type: 'execution.paused', payload: { reason: 'operator pause' }, severity: 'warn' },
    ]);
    expect(deriveStatusHeadline(headlineInputsOf(aggregateFromEvents(paused, 'run-p'))).text).toBe(
      'Execution paused by the operator.',
    );
  });
});

describe('deriveFactoryNeedsYou (factory-wide count)', () => {
  const openItem = (runId: string, id: string): InterventionItem => ({
    interventionId: id,
    runId,
    kind: 'deploy_setup',
    severity: 'warn',
    blockingStage: 'deploy',
    reason: 'needs credentials',
    requiredAction: 'connect credentials',
    raisedAt: 1000,
    sequence: 7,
    status: 'open',
  });

  it('unions cross-run open interventions with the focused run’s unpaired reviews', () => {
    const interventions: InterventionItem[] = [
      openItem('run-other', 'i-1'),
      { ...openItem('run-focused', 'i-2'), status: 'resolved', resolution: 'done' },
    ];
    // The OTHER run's intervention counts even while run-focused is in view,
    // and the focused run's pending review joins the union.
    expect(deriveFactoryNeedsYou(interventions, { unpairedReviewCount: 1 })).toBe(2);
    expect(deriveFactoryNeedsYou(interventions, null)).toBe(1);
    expect(deriveFactoryNeedsYou([], { unpairedReviewCount: 0 })).toBe(0);
  });
});
