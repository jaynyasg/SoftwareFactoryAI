// @vitest-environment jsdom
/**
 * Factory Floor component tests (jsdom). These render the control-room surfaces
 * from REAL core projections of the shared marketplace fixture and assert the
 * user-visible behavior the design contract requires: tickets/supervisor/workers/
 * ledger/confidence/deploy from events, the system-gated worker cap, the
 * reduced-trust treatment, the empty state with no fake progress, and the
 * machine-data middle-truncation affordance.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import {
  canReviewUnblock,
  projectArtifacts,
  projectOperator,
  projectResearch,
  projectRun,
  projectTickets,
} from '@software-factory/core';
import type { FactoryEvent } from '@software-factory/core';
import {
  buildFullFactoryRunEvents,
  buildMarketplaceRunEvents,
} from '../../../../tests/fixtures/marketplace-run';
import {
  executionJobId,
  projectExecutionQueue,
} from '../../src/server/execution/queue';
import { projectPreflight } from '../../src/server/execution/preflight';
import {
  filterInterventions,
  projectInterventions,
} from '../../src/server/execution/interventions';
import {
  deriveBlueprintLanes,
  deriveDeploy,
  deriveFactoryPulse,
  deriveGateOutcomes,
  derivePackage,
  derivePreview,
  deriveRepairSummaries,
  deriveReviews,
} from '../../src/lib/run-view';
import type {
  InterventionItem,
  InterventionQueueSnapshot,
  RunAggregate,
  SetupStatus,
} from '../../src/lib/types';
import { SessionProvider } from '../../src/components/session-context';
import { SupervisorPanel } from '../../src/components/factory-floor/SupervisorPanel';
import { WorkerBoard } from '../../src/components/factory-floor/WorkerBoard';
import { TicketCard } from '../../src/components/factory-floor/TicketCard';
import { TraceLedger } from '../../src/components/factory-floor/TraceLedger';
import { ArtifactConfidence } from '../../src/components/factory-floor/ArtifactConfidence';
import { DeployStatus } from '../../src/components/factory-floor/DeployStatus';
import { PackageHandoff } from '../../src/components/factory-floor/PackageHandoff';
import { SetupChecklist } from '../../src/components/factory-floor/SetupChecklist';
import { RunControl } from '../../src/components/factory-floor/RunControl';
import { RunView } from '../../src/components/factory-floor/RunView';
import { FactoryFloor } from '../../src/components/factory-floor/FactoryFloor';
import { ReviewStudio } from '../../src/components/factory-floor/ReviewStudio';
import { BlueprintLanes } from '../../src/components/factory-floor/BlueprintLanes';
import { ContractHandoff } from '../../src/components/factory-floor/ContractHandoff';
import { RunCommandBar } from '../../src/components/factory-floor/RunCommandBar';
import { InterventionQueue } from '../../src/components/factory-floor/InterventionQueue';
import { RunStrip } from '../../src/components/factory-floor/RunStrip';
import { Mono } from '../../src/components/factory-floor/primitives';
import type { BlockedStageView, BlueprintInputs, ReviewItem } from '../../src/lib/run-view';

const SESSION = { operatorToken: 'tok-test', csrfToken: 'csrf-test' };

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...rest
  }: { href: string; children: ReactNode } & Record<string, unknown>) => (
    <a href={typeof href === 'string' ? href : '#'} {...rest}>
      {children}
    </a>
  ),
}));

function aggregateFromEvents(events: readonly FactoryEvent[], runId: string): RunAggregate {
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

function buildAggregate(runId = 'run-test'): { aggregate: RunAggregate } {
  return { aggregate: aggregateFromEvents(buildMarketplaceRunEvents(runId), runId) };
}

function buildFullAggregate(runId = 'run-full'): {
  aggregate: RunAggregate;
  events: FactoryEvent[];
} {
  const events = buildFullFactoryRunEvents(runId);
  return { aggregate: aggregateFromEvents(events, runId), events };
}

function blueprintInputs(aggregate: RunAggregate): BlueprintInputs {
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

function pulseOf(aggregate: RunAggregate) {
  return deriveFactoryPulse({
    run: aggregate.run,
    tickets: aggregate.tickets,
    operator: aggregate.operator,
    preflight: aggregate.preflight,
    interventions: aggregate.interventions,
  });
}

function interventionItemsOf(events: readonly FactoryEvent[]): InterventionItem[] {
  return projectInterventions(events).interventions.map((item) => ({ ...item }));
}

function withSession(node: ReactElement): ReactElement {
  return <SessionProvider session={SESSION}>{node}</SessionProvider>;
}

describe('SupervisorPanel', () => {
  it('renders supervisor decisions with confidence and a ticket DAG overview', () => {
    const { aggregate } = buildAggregate();
    render(
      <SupervisorPanel decisions={aggregate.run.supervisorDecisions} tickets={aggregate.tickets} />,
    );

    expect(screen.getByText('classify-intent')).toBeInTheDocument();
    expect(screen.getByText(/confidence 90%/)).toBeInTheDocument();
    expect(screen.getByText('Ticket DAG overview')).toBeInTheDocument();
  });
});

describe('WorkerBoard', () => {
  it('shows active worker count and labels the cap as system-gated', () => {
    const { aggregate } = buildAggregate();
    render(
      <WorkerBoard
        tickets={aggregate.tickets}
        requestedCap={aggregate.run.requestedWorkerCap}
        adapterCapacity={aggregate.operator.adapterCapacity}
      />,
    );

    expect(screen.getByText('cap is system-gated')).toBeInTheDocument();
    // capacity throttled from requested 5 to adapter capacity 3
    expect(screen.getByText('capacity 3 / 5')).toBeInTheDocument();
    expect(screen.getByText(/3 active/)).toBeInTheDocument();
  });
});

describe('TicketCard', () => {
  it('renders ticket state, risk tier, and dependencies from the projection', () => {
    const { aggregate } = buildAggregate();
    const deploy = aggregate.tickets.find((t) => t.ticketId === 'deploy');
    expect(deploy).toBeDefined();
    render(<TicketCard ticket={deploy!} />);

    expect(screen.getByText('high risk')).toBeInTheDocument();
    expect(screen.getByLabelText('dependencies')).toHaveTextContent('package');
  });
});

describe('TraceLedger', () => {
  it('streams events in a polite live region and resumes from last_sequence when reconnecting', () => {
    const { aggregate } = buildAggregate();
    render(
      <TraceLedger
        rows={aggregate.run.ledger}
        lastSequence={aggregate.lastSequence}
        reconnecting
        diagnostics={aggregate.run.diagnostics}
      />,
    );

    const log = screen.getByRole('log');
    expect(log).toHaveAttribute('aria-live', 'polite');
    expect(within(log).getByText('run.created')).toBeInTheDocument();
    expect(within(log).getByText('gate.failed')).toBeInTheDocument();
    const reconnect = screen.getByTestId('ledger-reconnecting');
    expect(reconnect).toHaveTextContent(`sequence ${aggregate.lastSequence}`);
  });
});

describe('ArtifactConfidence', () => {
  it('shows the blended score AND its factor breakdown, not just a number', () => {
    const { aggregate } = buildAggregate();
    render(<ArtifactConfidence artifacts={aggregate.artifacts} reducedTrust />);

    expect(screen.getByTestId('confidence-score')).toHaveTextContent('72%');
    expect(screen.getByText('Gate pass rate')).toBeInTheDocument();
    expect(screen.getByText('Provenance completeness')).toBeInTheDocument();
    expect(screen.getByText('Dependency risk (inverted)')).toBeInTheDocument();
    expect(screen.getByText('Preview evidence')).toBeInTheDocument();
    expect(screen.getAllByText('reduced trust').length).toBeGreaterThan(0);
  });
});

describe('DeployStatus', () => {
  it('shows the phase and never reveals a hosted URL before hosted_ready', () => {
    const { aggregate } = buildAggregate();
    render(<DeployStatus deploy={aggregate.deploy} />);

    expect(screen.getByTestId('deploy-phase')).toHaveTextContent('Setup required');
    expect(screen.queryByTestId('hosted-url')).toBeNull();
    expect(screen.getByText(/Connect a GitHub destination/)).toBeInTheDocument();
  });
});

describe('PackageHandoff', () => {
  it('shows an honest not-packaged state before package.created exists', () => {
    const { aggregate } = buildAggregate(); // fixture has no package.created
    render(<PackageHandoff pkg={aggregate.packageView} />);

    expect(screen.getByTestId('package-status')).toHaveTextContent('Not packaged');
    expect(screen.getByText(/appear after all tickets and post-run gates/)).toBeInTheDocument();
  });

  it('shows repo, handoff, provenance, and confidence once packaged', () => {
    render(
      <PackageHandoff
        pkg={{
          status: 'packaged',
          repoPath: 'C:\\factory\\workspaces\\run-1',
          handoffRef: 'HANDOFF.md',
          provenanceRef: 'PROVENANCE.json',
          commit: '0123456789abcdef',
          summary: 'Packaged app as a git repo at commit 0123456.',
          artifactId: 'app',
          confidence: 0.87,
        }}
      />,
    );

    expect(screen.getByTestId('package-status')).toHaveTextContent('Packaged');
    expect(screen.getByText('HANDOFF.md')).toBeInTheDocument();
    expect(screen.getByText('PROVENANCE.json')).toBeInTheDocument();
    expect(screen.getByTestId('package-confidence')).toHaveTextContent('87%');
    // The local-first contract stays visible: package survives deploy pauses.
    expect(screen.getByText(/preserved even when the hosted deploy pauses/)).toBeInTheDocument();
  });
});

describe('SetupChecklist', () => {
  it('renders the blocking setup-required state when the operator token is absent', () => {
    const setup: SetupStatus = {
      operatorToken: { present: false },
      sandbox: { status: 'unknown' },
      adapters: { status: 'unknown', detected: [] },
      deploy: { status: 'required' },
      workspace: { root: 'C:\\repo\\software-factory' },
    };
    render(<SetupChecklist setup={setup} />);
    expect(screen.getByTestId('setup-required')).toBeInTheDocument();
    expect(screen.getByText('Local operator token')).toBeInTheDocument();
  });
});

describe('RunControl', () => {
  it('exposes a 1..20 worker cap, defaults to 10, and labels it system-gated', () => {
    render(withSession(<RunControl defaultLocalFolder={'C:\\repo\\software-factory'} />));
    const cap = screen.getByLabelText('Worker cap (1–20)') as HTMLInputElement;
    expect(cap).toHaveAttribute('type', 'range');
    expect(cap).toHaveAttribute('min', '1');
    expect(cap).toHaveAttribute('max', '20');
    expect(cap).toHaveValue('10');
    expect(screen.getByLabelText('Effort budget')).toHaveValue('extra high');
    expect(screen.getByLabelText('Local folder')).toHaveValue('C:\\repo\\software-factory');
    expect(screen.getByLabelText('GitHub repository')).toBeInTheDocument();
    expect(screen.getByText('upper bound · system-gated')).toBeInTheDocument();
    expect(screen.getByLabelText('Prompt (optional)')).toBeInTheDocument();
    expect(screen.getByLabelText('PRD (optional)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Browse PRD' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Browse' })).toBeInTheDocument();
  });
});

describe('Mono', () => {
  it('middle-truncates long machine values, keeps the full value, and offers copy', () => {
    const long = 'generated/ai-services-marketplace/apps/web/app/very/deep/path/page.tsx';
    render(<Mono value={long} max={20} />);
    const text = screen.getByText(/…/);
    expect(text).toHaveTextContent('…');
    expect(text).toHaveAttribute('title', long);
    expect(screen.getByRole('button', { name: `Copy ${long}` })).toBeInTheDocument();
  });
});

describe('RunView (active run integration)', () => {
  it('renders tickets, supervisor, workers, ledger, deploy, and the reduced-trust banner from events', () => {
    const { aggregate } = buildAggregate();
    render(
      withSession(
        <RunView
          snapshot={aggregate}
          rows={aggregate.run.ledger}
          reconnecting={false}
          refresh={() => {}}
        />,
      ),
    );

    expect(screen.getByLabelText('Supervisor')).toBeInTheDocument();
    expect(screen.getByLabelText('Worker board')).toBeInTheDocument();
    expect(screen.getByLabelText('Trace ledger')).toBeInTheDocument();
    expect(screen.getByLabelText('Review studio')).toBeInTheDocument();
    expect(screen.getByLabelText('Deploy status')).toBeInTheDocument();
    expect(screen.getByText('Scaffold the marketplace app')).toBeInTheDocument();
    expect(screen.getByTestId('run-reduced-trust')).toBeInTheDocument();
  });
});

describe('ReviewStudio gate visibility + blocked stages (U7)', () => {
  const COUNTS = { warn: 1, error: 1, critical: 0 };

  it('renders latest gate outcomes with stage, attempts, and evidence detail', () => {
    const { aggregate } = buildAggregate();
    render(
      withSession(
        <ReviewStudio
          runId="run-test"
          reviewMode="human"
          expectedVersion={aggregate.lastSequence}
          reviews={[]}
          artifacts={aggregate.artifacts}
          counts={aggregate.operator.counts}
          gates={aggregate.gates}
          repairs={aggregate.repairs}
          blockedStages={[]}
        />,
      ),
    );

    const rows = screen.getAllByTestId('gate-row');
    expect(rows.length).toBeGreaterThanOrEqual(2);
    // The marketplace fixture records a lint pass and a test failure.
    const lint = rows.find((row) => within(row).queryByText('lint') !== null);
    const test = rows.find((row) => within(row).queryByText('test') !== null);
    expect(lint).toBeDefined();
    expect(within(lint!).getByText('passed')).toBeInTheDocument();
    expect(test).toBeDefined();
    expect(within(test!).getByText('failed')).toBeInTheDocument();
  });

  it('marks policy blocks as never approvable and offers no decision card for them', () => {
    const blockedStages: BlockedStageView[] = [
      {
        interventionId: 'run-test:execution:blocked:1',
        kind: 'policy_block',
        blockingStage: 'execution',
        severity: 'warn',
        reason: 'The plan requires human triage before any build execution.',
        requiredAction: 'Complete triage, re-plan, and start again.',
        approvable: false,
      },
      {
        interventionId: 'run-test:gates:blocked:1',
        kind: 'retry_choice',
        blockingStage: 'gates',
        severity: 'warn',
        reason: 'Post-run gate "unit-test" failed.',
        requiredAction: 'Fix the cause, then re-run gates or approve the stage review.',
        approvable: true,
      },
    ];
    render(
      withSession(
        <ReviewStudio
          runId="run-test"
          reviewMode="autonomous"
          expectedVersion={7}
          reviews={[]}
          artifacts={[]}
          counts={COUNTS}
          blockedStages={blockedStages}
        />,
      ),
    );

    expect(screen.getAllByTestId('blocked-stage')).toHaveLength(2);
    // KTD6: the policy block is loudly not-approvable, in autonomous mode too.
    expect(screen.getByTestId('policy-blocked')).toHaveTextContent(/cannot be approved/i);
    // No decision card exists at all (no pending stage review was supplied).
    expect(screen.queryByRole('group', { name: /review decision/i })).toBeNull();
  });

  it('renders a decision card for a pending STAGE review at any tier and mode', () => {
    const reviews: ReviewItem[] = [
      {
        sequence: 12,
        riskTier: 'low',
        summary: 'Post-run gate "unit-test" failed.',
        status: 'pending',
        evidence: [{ label: 'unit-test:failure', ref: 'exit:1', note: '2 tests failed' }],
        stage: 'gates',
      },
    ];
    render(
      withSession(
        <ReviewStudio
          runId="run-test"
          reviewMode="autonomous"
          expectedVersion={12}
          reviews={reviews}
          artifacts={[]}
          counts={COUNTS}
        />,
      ),
    );

    const card = screen.getByRole('group', { name: /review decision/i });
    expect(card).toBeInTheDocument();
    expect(within(card).getByText(/resumes the gates stage/i)).toBeInTheDocument();
    expect(
      within(card).getByRole('button', { name: /approve low-risk review/i }),
    ).toBeInTheDocument();
  });
});

describe('FactoryFloor empty state', () => {
  it('offers prompt/PRD entry and setup status with no fake progress', () => {
    const setup: SetupStatus = {
      operatorToken: { present: true },
      sandbox: { status: 'unknown' },
      adapters: { status: 'unknown', detected: [] },
      deploy: { status: 'required' },
      workspace: { root: 'C:\\repo\\software-factory' },
    };
    render(withSession(<FactoryFloor initialRuns={[]} setup={setup} latest={null} />));

    expect(screen.getByLabelText('Prompt (optional)')).toBeInTheDocument();
    expect(screen.getByLabelText('PRD (optional)')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Operator view' })).toHaveAttribute(
      'href',
      '/operator',
    );
    expect(screen.getByLabelText('Setup checklist')).toBeInTheDocument();
    expect(screen.getByText('No runs yet.')).toBeInTheDocument();
    // Anti-slop: no fake progress in the empty state.
    expect(screen.queryByRole('progressbar')).toBeNull();
    // The empty intervention queue is a DESIGNED feature state, not bare text.
    expect(screen.getByTestId('interventions-empty')).toHaveTextContent(
      /nothing needs you — the factory is running clean/i,
    );
  });
});

describe('BlueprintLanes (U9)', () => {
  it('renders all eight pipeline lanes from replayed projections', () => {
    const { aggregate } = buildFullAggregate();
    render(<BlueprintLanes inputs={blueprintInputs(aggregate)} pulse={pulseOf(aggregate)} />);

    for (const lane of [
      'research',
      'planning',
      'queue',
      'workers',
      'gates',
      'repair',
      'package',
      'deploy',
    ]) {
      expect(screen.getByTestId(`lane-${lane}`)).toBeInTheDocument();
    }
    // §6 reduced-trust: the fixture's sandbox fallback is loudly labeled.
    expect(screen.getByText('reduced trust')).toBeVisible();
    expect(within(screen.getByTestId('lane-research')).getByText('brief complete')).toBeVisible();
    expect(
      within(screen.getByTestId('lane-research')).getByText(/2 findings · 2 sources · 1 open gaps/),
    ).toBeVisible();
    expect(within(screen.getByTestId('lane-gates')).getByText('failing')).toBeVisible();
    expect(within(screen.getByTestId('lane-deploy')).getByText('setup required')).toBeVisible();
    expect(
      within(screen.getByTestId('lane-workers')).getByText(/capacity 3\/5/),
    ).toBeVisible();
  });

  it('shows research findings and source evidence without raw JSON', () => {
    const { aggregate } = buildFullAggregate();
    render(<BlueprintLanes inputs={blueprintInputs(aggregate)} pulse={pulseOf(aggregate)} />);

    const researchLane = screen.getByTestId('lane-research');
    fireEvent.click(within(researchLane).getByText('evidence'));

    expect(
      screen.getByText(/repo already contains a provider\/request scaffold/),
    ).toBeInTheDocument();
    expect(screen.getByText('verified fact')).toBeInTheDocument();
    // Source evidence: locator rendered as machine data, not a JSON dump.
    expect(
      screen.getByText('generated/ai-services-marketplace/apps/web'),
    ).toBeInTheDocument();
    expect(screen.getByText(/which payment provider/i)).toBeInTheDocument();
    expect(researchLane.textContent).not.toContain('{');
  });

  it('shows the pulse with capacity, queue, throttle reason, and blocking item', () => {
    const { aggregate } = buildFullAggregate();
    render(<BlueprintLanes inputs={blueprintInputs(aggregate)} pulse={pulseOf(aggregate)} />);

    const pulse = screen.getByTestId('factory-pulse');
    expect(within(pulse).getByText('3 active')).toBeVisible();
    expect(within(pulse).getByText('3/5')).toBeVisible();
    expect(screen.getByTestId('pulse-throttle')).toHaveTextContent(/CPU budget reached/);
    expect(screen.getByTestId('pulse-blocking')).toHaveTextContent(
      /deploy: Connect the GitHub destination/,
    );
  });

  it('updates queue and capacity reasons as events arrive (projection replay)', () => {
    const runId = 'run-live';
    const events = buildFullFactoryRunEvents(runId);
    const throttleIndex = events.findIndex((e) => e.type === 'adapter.capacity_changed');
    expect(throttleIndex).toBeGreaterThan(0);

    const before = aggregateFromEvents(events.slice(0, throttleIndex), runId);
    const after = aggregateFromEvents(events, runId);

    const beforeLanes = deriveBlueprintLanes(blueprintInputs(before));
    const afterLanes = deriveBlueprintLanes(blueprintInputs(after));
    const workersBefore = beforeLanes.find((lane) => lane.id === 'workers');
    const workersAfter = afterLanes.find((lane) => lane.id === 'workers');
    expect(workersBefore?.metric).toContain('capacity 5/5');
    expect(workersAfter?.metric).toContain('capacity 3/5');
    expect(pulseOf(before).throttleReason).toBeUndefined();
    expect(pulseOf(after).throttleReason).toMatch(/CPU budget reached/);
  });
});

describe('ContractHandoff (U9)', () => {
  it('renders the build contract as structured rows, never raw JSON', () => {
    const { aggregate } = buildFullAggregate();
    render(
      <ContractHandoff contract={aggregate.run.buildContract} preflight={aggregate.preflight} />,
    );

    const contract = screen.getByTestId('build-contract');
    expect(within(contract).getByText(/12 tickets from scaffold through hosted deploy/)).toBeVisible();
    expect(
      within(contract).getByTitle('generated/ai-services-marketplace/**'),
    ).toBeInTheDocument();
    expect(within(contract).getByText(/deploy ticket is high-risk/)).toBeVisible();
    expect(within(contract).getByText('secret-scan')).toBeVisible();
    expect(within(contract).getByText('render:ai-services-marketplace')).toBeVisible();
    expect(
      within(contract).getByText(/High-risk deploy requires 2 approvals/),
    ).toBeVisible();
    expect(within(contract).getByText('research-backed')).toBeVisible();
    expect(contract.textContent).not.toContain('"scope"');
  });

  it('renders preflight check rows with pass state', () => {
    const { aggregate } = buildFullAggregate();
    render(
      <ContractHandoff contract={aggregate.run.buildContract} preflight={aggregate.preflight} />,
    );

    expect(screen.getByText('preflight passed · attempt 1')).toBeVisible();
    const rows = screen.getAllByTestId('preflight-check');
    expect(rows).toHaveLength(8);
    expect(within(rows[0]).getByText('pass')).toBeVisible();
  });

  it('shows honest empty states before contract and preflight exist', () => {
    render(
      <ContractHandoff
        contract={undefined}
        preflight={{ status: 'none', attempt: 0, checks: [], failedChecks: [] }}
      />,
    );
    expect(screen.getByTestId('contract-empty')).toHaveTextContent(/No build contract yet/);
    expect(screen.getByText(/Not rehearsed yet/)).toBeVisible();
    expect(screen.getByText('preflight pending')).toBeVisible();
  });
});

describe('RunCommandBar (U9)', () => {
  it('offers Start for a planned run that has not requested execution', () => {
    render(
      withSession(
        <RunCommandBar
          runId="run-a"
          status="planned"
          executionState="not_requested"
          lastSequence={10}
        />,
      ),
    );
    expect(screen.getByRole('button', { name: /start execution for run run-a/i })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /pause/i })).toBeNull();
  });

  it('offers Pause + Cancel while execution is started', () => {
    const { aggregate } = buildFullAggregate('run-b');
    expect(aggregate.run.executionState).toBe('started');
    render(
      withSession(
        <RunCommandBar
          runId="run-b"
          status={aggregate.run.status}
          executionState={aggregate.run.executionState}
          lastSequence={aggregate.lastSequence}
          preview={aggregate.preview}
          deploy={aggregate.deploy}
        />,
      ),
    );
    expect(screen.getByRole('button', { name: /pause execution/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /cancel run/i })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /start execution/i })).toBeNull();
    // Preview/deploy badges stay honest (from events).
    expect(screen.getByTestId('preview-status')).toHaveTextContent('ready');
    expect(screen.getByTestId('deploy-summary')).toHaveTextContent('setup required');
  });

  it('offers Resume when paused and Retry with the reason when blocked', () => {
    const { rerender } = render(
      withSession(
        <RunCommandBar runId="run-c" status="running" executionState="paused" lastSequence={5} />,
      ),
    );
    expect(screen.getByRole('button', { name: /resume execution/i })).toBeEnabled();

    rerender(
      withSession(
        <RunCommandBar
          runId="run-c"
          status="running"
          executionState="blocked"
          executionReason="preflight failed: credentials"
          lastSequence={5}
        />,
      ),
    );
    expect(screen.getByRole('button', { name: /retry execution/i })).toBeEnabled();
    expect(screen.getByTestId('execution-reason')).toHaveTextContent(/preflight failed/);
  });
});

describe('InterventionQueue (U9/X4)', () => {
  function twoRunQueue(): InterventionQueueSnapshot {
    const a = interventionItemsOf(buildFullFactoryRunEvents('run-alpha'));
    const b = interventionItemsOf(buildFullFactoryRunEvents('run-beta'));
    const interventions = [...a, ...b];
    return { interventions, openCount: interventions.length };
  }

  it('lists interventions across runs with run id, stage, and ledger link', () => {
    render(withSession(<InterventionQueue snapshot={twoRunQueue()} />));

    const items = screen.getAllByTestId('intervention-item');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveAttribute('data-run-id', 'run-alpha');
    expect(items[1]).toHaveAttribute('data-run-id', 'run-beta');
    expect(
      within(items[0]).getByRole('link', { name: /open ledger evidence/i }),
    ).toHaveAttribute('href', '/runs/run-alpha');
    expect(within(items[0]).getByText(/seq \d+/)).toBeInTheDocument();
  });

  it('filters by run, severity, blocking stage, and required action', () => {
    render(withSession(<InterventionQueue snapshot={twoRunQueue()} />));

    fireEvent.change(screen.getByLabelText('Filter interventions by run'), {
      target: { value: 'run-beta' },
    });
    expect(screen.getAllByTestId('intervention-item')).toHaveLength(1);
    expect(screen.getByTestId('intervention-item')).toHaveAttribute('data-run-id', 'run-beta');

    fireEvent.change(screen.getByLabelText('Filter interventions by run'), {
      target: { value: 'all' },
    });
    fireEvent.change(screen.getByLabelText('Filter interventions by severity'), {
      target: { value: 'critical' },
    });
    expect(screen.queryAllByTestId('intervention-item')).toHaveLength(0);
    expect(screen.getByTestId('interventions-empty')).toHaveTextContent(/nothing matches/i);

    fireEvent.change(screen.getByLabelText('Filter interventions by severity'), {
      target: { value: 'warn' },
    });
    fireEvent.change(screen.getByLabelText('Filter interventions by blocking stage'), {
      target: { value: 'deploy' },
    });
    fireEvent.change(screen.getByLabelText('Filter interventions by required action'), {
      target: { value: 'render credentials' },
    });
    expect(screen.getAllByTestId('intervention-item')).toHaveLength(2);
  });

  it('renders the designed empty state when the factory is running clean', () => {
    render(withSession(<InterventionQueue snapshot={{ interventions: [], openCount: 0 }} />));
    const empty = screen.getByTestId('interventions-empty');
    expect(empty).toHaveTextContent(/nothing needs you — the factory is running clean/i);
    expect(empty).toHaveTextContent(/across every run/i);
  });

  it('offers Focus for other runs and asks for a resolution before resolving', () => {
    const onFocus = vi.fn();
    render(
      withSession(
        <InterventionQueue
          snapshot={twoRunQueue()}
          focusedRunId="run-alpha"
          onFocusRun={onFocus}
        />,
      ),
    );

    // The focused run's item offers no Focus button; the other run's does.
    const items = screen.getAllByTestId('intervention-item');
    expect(within(items[0]).queryByRole('button', { name: /focus run/i })).toBeNull();
    fireEvent.click(within(items[1]).getByRole('button', { name: /focus run run-beta/i }));
    expect(onFocus).toHaveBeenCalledWith('run-beta');

    // Resolve requires an explicit ledger-recorded resolution.
    fireEvent.click(within(items[0]).getByRole('button', { name: /resolve intervention/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Record' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/state how this was resolved/i);
  });
});

describe('RunStrip (U9)', () => {
  it('marks the focused run and switches focus on press', () => {
    const runs = [
      projectRun(buildFullFactoryRunEvents('run-one'), 'run-one'),
      projectRun(buildMarketplaceRunEvents('run-two'), 'run-two'),
    ];
    const onFocus = vi.fn();
    render(
      <RunStrip
        runs={runs}
        focusedRunId="run-one"
        openInterventionsByRun={{ 'run-one': 1 }}
        onFocus={onFocus}
      />,
    );

    const one = screen.getByRole('button', { name: 'Focus run run-one' });
    expect(one).toHaveAttribute('aria-pressed', 'true');
    expect(within(one).getByText('1 open')).toBeInTheDocument();

    const two = screen.getByRole('button', { name: 'Focus run run-two' });
    expect(two).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(two);
    expect(onFocus).toHaveBeenCalledWith('run-two');
  });
});

describe('FactoryFloor blueprint-first hierarchy (U9/KTD7)', () => {
  const setup: SetupStatus = {
    operatorToken: { present: true },
    sandbox: { status: 'available' },
    adapters: { status: 'ready', detected: ['codex-cli'] },
    deploy: { status: 'required' },
    workspace: { root: 'C:\\repo\\software-factory' },
  };

  function renderFloor() {
    const runId = 'run-floor';
    const events = buildFullFactoryRunEvents(runId);
    const aggregate = aggregateFromEvents(events, runId);
    const items = interventionItemsOf(events);
    return render(
      withSession(
        <FactoryFloor
          initialRuns={[aggregate.run]}
          setup={setup}
          latest={aggregate}
          initialInterventions={{ interventions: items, openCount: items.length }}
        />,
      ),
    );
  }

  it('orders interventions above the blueprint, controls, then run history', () => {
    renderFloor();

    const interventions = screen.getByLabelText('Operator interventions');
    const blueprint = screen.getByLabelText('Factory blueprint');
    const intake = screen.getByLabelText('Run control');
    const history = screen.getByLabelText('Runs');

    const before = (a: Element, b: Element): boolean =>
      (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    expect(before(interventions, blueprint)).toBe(true);
    expect(before(blueprint, intake)).toBe(true);
    expect(before(intake, history)).toBe(true);

    // The blueprint region includes the contract handoff with commands adjacent.
    expect(screen.getByLabelText('Build contract and preflight')).toBeInTheDocument();
    expect(screen.getByTestId('run-command-bar')).toBeInTheDocument();
  });

  it('clearing run history preserves the focused blueprint', () => {
    renderFloor();

    expect(screen.getByTestId('blueprint-run')).toHaveTextContent(/run-floor/);
    fireEvent.click(screen.getByRole('button', { name: 'Clear view' }));

    expect(screen.getByText(/Run history is hidden/)).toBeInTheDocument();
    // Focus (and the lanes) survive the clear — KTD7.
    expect(screen.getByLabelText('Factory blueprint')).toBeInTheDocument();
    expect(screen.getByTestId('blueprint-run')).toHaveTextContent(/run-floor/);
  });
});
