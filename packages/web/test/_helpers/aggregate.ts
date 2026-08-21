/**
 * Shared test builder: fold REAL core/server projections of a fixture event
 * list into the client `RunAggregate` shape, exactly the way
 * `server/run-data.ts` does — so component and hook tests always render from
 * genuine projected state, never hand-invented view models.
 */
import {
  canReviewUnblock,
  projectArtifacts,
  projectOperator,
  projectResearch,
  projectRun,
  projectTickets,
} from '@software-factory/core';
import type { FactoryEvent } from '@software-factory/core';
import { executionJobId, projectExecutionQueue } from '../../src/server/execution/queue';
import { projectPreflight } from '../../src/server/execution/preflight';
import {
  filterInterventions,
  projectInterventions,
} from '../../src/server/execution/interventions';
import {
  deriveDeploy,
  deriveGateOutcomes,
  derivePackage,
  derivePreview,
  deriveRepairSummaries,
  deriveReviews,
} from '../../src/lib/run-view';
import type { RunAggregate } from '../../src/lib/types';

export function aggregateFromEvents(events: readonly FactoryEvent[], runId: string): RunAggregate {
  const run = projectRun(events, runId);
  return {
    run,
    tickets: projectTickets(events, runId).tickets,
    artifacts: projectArtifacts(events, runId).artifacts,
    operator: projectOperator(events, runId),
    research: projectResearch(events, runId),
    preflight: projectPreflight(events, runId),
    executionJob: projectExecutionQueue(events, runId).byJobId[executionJobId(runId)] ?? null,
    preview: derivePreview(events),
    deploy: deriveDeploy(events),
    packageView: derivePackage(events),
    reviews: deriveReviews(events),
    gates: deriveGateOutcomes(events),
    repairs: deriveRepairSummaries(events),
    interventions: filterInterventions(projectInterventions(events), {
      runId,
      openOnly: true,
    }).map((item) => ({
      interventionId: item.interventionId,
      kind: item.kind,
      blockingStage: item.blockingStage,
      severity: item.severity,
      reason: item.reason,
      requiredAction: item.requiredAction,
      approvable: canReviewUnblock(item.kind),
    })),
    lastSequence: run.lastSequence,
    tail: run.ledger,
  };
}
