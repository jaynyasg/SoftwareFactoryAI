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
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { projectRun } from '@software-factory/core';
import type { FactoryEvent } from '@software-factory/core';
import {
  buildFullFactoryRunEvents,
  buildMarketplaceRunEvents,
} from '../../../../tests/fixtures/marketplace-run';
import { aggregateFromEvents } from '../_helpers/aggregate';
import { projectInterventions } from '../../src/server/execution/interventions';
import { deriveBlueprintLanes, deriveFactoryPulse } from '../../src/lib/run-view';
import { useInterventionQueue } from '../../src/lib/use-intervention-queue';
import type {
  ExecutionOverview,
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
import { RunDecisions } from '../../src/components/factory-floor/RunDecisions';
import { RunReport } from '../../src/components/factory-floor/RunReport';
import { RunCompletionToast } from '../../src/components/factory-floor/RunCompletionToast';
import { RunProgress } from '../../src/components/factory-floor/RunProgress';
import { RunCommandBar } from '../../src/components/factory-floor/RunCommandBar';
import { FactoryCommandBar } from '../../src/components/factory-floor/FactoryCommandBar';
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
    // NEVER pre-filled: a silently-defaulted folder once aimed a run's write
    // boundary at the factory's own source. Empty = fresh generated workspace.
    expect(screen.getByLabelText('Local folder')).toHaveValue('');
    expect(screen.getByLabelText('Local folder')).toHaveAttribute(
      'placeholder',
      'empty = fresh generated workspace',
    );
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
    // View switching lives in the AppShell header now (AppShellNav), so the
    // floor itself renders no Operator link — see app-shell.test.tsx.
    expect(screen.queryByRole('link', { name: 'Status view' })).toBeNull();
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
    expect(within(screen.getByTestId('lane-workers')).getByText(/capacity 3\/5/)).toBeVisible();
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
    expect(screen.getByText('generated/ai-services-marketplace/apps/web')).toBeInTheDocument();
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
    expect(
      within(contract).getByText(/12 tickets from scaffold through hosted deploy/),
    ).toBeVisible();
    expect(within(contract).getByTitle('generated/ai-services-marketplace/**')).toBeInTheDocument();
    expect(within(contract).getByText(/deploy ticket is high-risk/)).toBeVisible();
    expect(within(contract).getByText('secret-scan')).toBeVisible();
    expect(within(contract).getByText('render:ai-services-marketplace')).toBeVisible();
    expect(within(contract).getByText(/High-risk deploy requires 2 approvals/)).toBeVisible();
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

  it('offers a mid-run model override that posts to the settings endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ runId: 'run-m', run: {} }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const onChanged = vi.fn();
    try {
      render(
        withSession(
          <RunCommandBar
            runId="run-m"
            status="running"
            executionState="failed"
            selectedAdapter="claude-code-cli"
            modelProfile="claude-fable-5"
            lastSequence={9}
            onChanged={onChanged}
          />,
        ),
      );
      const select = screen.getByLabelText('Model for run run-m');
      expect(select).toHaveValue('claude-fable-5');
      // No Apply button until the selection actually differs.
      expect(screen.queryByRole('button', { name: 'Apply to remaining tickets' })).toBeNull();
      fireEvent.change(select, { target: { value: 'claude-sonnet-5' } });
      fireEvent.click(screen.getByRole('button', { name: 'Apply to remaining tickets' }));
      await waitFor(() => expect(onChanged).toHaveBeenCalled());
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/runs/run-m/settings',
        expect.objectContaining({ method: 'POST' }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('offers Start (not Retry) when blocked before any job was enqueued', () => {
    // A preflight-blocked start never enqueued a job: the server rejects retry
    // ("use start instead"), so the bar must offer Start, closing the
    // fix -> Start -> re-rehearse loop the rehearsal summary promises.
    render(
      withSession(
        <RunCommandBar
          runId="run-d"
          status="planned"
          executionState="blocked"
          executionReason="Preflight failed: credentials."
          hasExecutionJob={false}
          lastSequence={5}
        />,
      ),
    );
    expect(screen.getByRole('button', { name: /start execution for run run-d/i })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /retry execution/i })).toBeNull();
  });

  it('ignores a command that settles after unmount (no onChanged, no state update)', async () => {
    let settle: (response: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => {
      settle = resolve;
    });
    const fetchMock = vi.fn(() => pending);
    vi.stubGlobal('fetch', fetchMock);
    const onChanged = vi.fn();
    try {
      const { unmount } = render(
        withSession(
          <RunCommandBar
            runId="run-gone"
            status="planned"
            executionState="not_requested"
            lastSequence={3}
            onChanged={onChanged}
          />,
        ),
      );
      fireEvent.click(screen.getByRole('button', { name: /start execution/i }));
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // The screen navigates away while the command is in flight…
      unmount();
      await act(async () => {
        settle(
          new Response(JSON.stringify({ runId: 'run-gone', queued: true }), {
            status: 202,
            headers: { 'content-type': 'application/json' },
          }),
        );
      });

      // …so the late result must not trigger the parent refresh (or setState).
      expect(onChanged).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('FactoryCommandBar (factory drain gate)', () => {
  const HELD_EXECUTION: ExecutionOverview = {
    execution: { enabled: true, held: true, running: true },
    queue: { queued: 2, leased: 0 },
  };
  const ACTIVE_EXECUTION: ExecutionOverview = {
    execution: { enabled: true, held: false, running: true },
    queue: { queued: 0, leased: 1 },
  };

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  it('renders the held banner with Resume and Cancel all while the gate is engaged', () => {
    render(withSession(<FactoryCommandBar initial={HELD_EXECUTION} />));

    const banner = screen.getByTestId('factory-held-banner');
    // The banner states the guarantee honestly: nothing runs automatically.
    expect(banner).toHaveTextContent(/Execution is held — nothing runs automatically/);
    expect(banner).toHaveTextContent(/2 tasks are waiting for your resume/);
    expect(screen.getByTestId('factory-resume')).toBeEnabled();
    expect(screen.getByTestId('cancel-all-tasks')).toBeEnabled();
    expect(screen.queryByTestId('factory-active-badge')).toBeNull();
  });

  it('renders the active badge with Hold and Cancel all once the gate is released', () => {
    render(withSession(<FactoryCommandBar initial={ACTIVE_EXECUTION} />));

    expect(screen.getByTestId('factory-active-badge')).toHaveTextContent('execution active');
    expect(screen.getByTestId('factory-hold')).toBeEnabled();
    expect(screen.getByTestId('cancel-all-tasks')).toBeEnabled();
    expect(screen.queryByTestId('factory-held-banner')).toBeNull();
  });

  it('an EMPTY held factory shows only the quiet gate badge — no banner, no dead buttons', () => {
    render(
      withSession(
        <FactoryCommandBar
          initial={{
            execution: { enabled: true, held: true, running: true },
            queue: { queued: 0, leased: 0 },
          }}
          runCount={0}
          cancellableRunCount={0}
        />,
      ),
    );

    expect(screen.getByTestId('factory-held-badge')).toHaveTextContent(/execution held/);
    expect(screen.queryByTestId('factory-held-banner')).toBeNull();
    expect(screen.queryByTestId('factory-resume')).toBeNull();
    expect(screen.queryByTestId('cancel-all-tasks')).toBeNull();
    expect(screen.queryByTestId('clear-all-tasks')).toBeNull();
  });

  it('an EMPTY active factory shows only the quiet active badge', () => {
    render(
      withSession(
        <FactoryCommandBar
          initial={{
            execution: { enabled: true, held: false, running: true },
            queue: { queued: 0, leased: 0 },
          }}
          runCount={0}
          cancellableRunCount={0}
        />,
      ),
    );

    expect(screen.getByTestId('factory-active-badge')).toBeInTheDocument();
    expect(screen.queryByTestId('factory-hold')).toBeNull();
    expect(screen.queryByTestId('cancel-all-tasks')).toBeNull();
    expect(screen.queryByTestId('clear-all-tasks')).toBeNull();
  });

  it('held with terminal-only history: quiet badge + Clear everything, but no Resume or Cancel all', () => {
    render(
      withSession(
        <FactoryCommandBar
          initial={{
            execution: { enabled: true, held: true, running: true },
            queue: { queued: 0, leased: 0 },
          }}
          runCount={3}
          cancellableRunCount={0}
        />,
      ),
    );

    expect(screen.getByTestId('factory-held-badge')).toBeInTheDocument();
    expect(screen.getByTestId('clear-all-tasks')).toBeEnabled();
    expect(screen.queryByTestId('factory-resume')).toBeNull();
    expect(screen.queryByTestId('cancel-all-tasks')).toBeNull();
    expect(screen.queryByTestId('factory-held-banner')).toBeNull();
  });

  it('renders nothing on an instance without execution controls', () => {
    const { container } = render(
      withSession(
        <FactoryCommandBar
          initial={{
            execution: { enabled: false, held: false, running: false },
            queue: { queued: 0, leased: 0 },
          }}
        />,
      ),
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('cancel-all is two-step: arming focuses the safe option and Keep running fires no request', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      render(withSession(<FactoryCommandBar initial={ACTIVE_EXECUTION} />));

      fireEvent.click(screen.getByTestId('cancel-all-tasks'));
      const confirm = screen.getByRole('group', { name: 'Confirm cancel all tasks' });
      expect(within(confirm).getByTestId('cancel-all-confirm')).toBeInTheDocument();
      // Focus lands on the SAFE "Keep running" option, never the destructive one.
      expect(screen.getByTestId('cancel-all-keep')).toHaveFocus();

      fireEvent.click(screen.getByTestId('cancel-all-keep'));
      expect(screen.queryByRole('group', { name: 'Confirm cancel all tasks' })).toBeNull();
      // Disarming returns focus to the arm button — and cancels NOTHING.
      expect(screen.getByTestId('cancel-all-tasks')).toHaveFocus();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('Escape disarms the cancel-all confirm without firing the command', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      render(withSession(<FactoryCommandBar initial={HELD_EXECUTION} />));

      fireEvent.click(screen.getByTestId('cancel-all-tasks'));
      fireEvent.keyDown(screen.getByRole('group', { name: 'Confirm cancel all tasks' }), {
        key: 'Escape',
      });
      expect(screen.queryByRole('group', { name: 'Confirm cancel all tasks' })).toBeNull();
      expect(screen.getByTestId('cancel-all-tasks')).toHaveFocus();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('confirmed cancel-all posts the command and reports the zero-count outcome honestly', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) =>
      Promise.resolve(
        String(input) === '/api/runs/cancel-all'
          ? jsonResponse({
              cancelled: [],
              alreadyCancelled: ['run-old'],
              skippedTerminal: [],
              cancelledCount: 0,
            })
          : // The post-command refresh() re-polls the overview immediately.
            jsonResponse(ACTIVE_EXECUTION),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      render(withSession(<FactoryCommandBar initial={ACTIVE_EXECUTION} />));

      fireEvent.click(screen.getByTestId('cancel-all-tasks'));
      await act(async () => {
        fireEvent.click(screen.getByTestId('cancel-all-confirm'));
      });

      expect(fetchMock).toHaveBeenCalledWith(
        '/api/runs/cancel-all',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(screen.getByTestId('factory-command-notice')).toHaveTextContent(
        'No active tasks to cancel — every run was already finished or cancelled.',
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('confirmed cancel-all reports one cancelled run in the singular and refreshes the parent', async () => {
    const onChanged = vi.fn();
    const fetchMock = vi.fn((input: RequestInfo | URL) =>
      Promise.resolve(
        String(input) === '/api/runs/cancel-all'
          ? jsonResponse({
              cancelled: ['run-one'],
              alreadyCancelled: [],
              skippedTerminal: [],
              cancelledCount: 1,
            })
          : jsonResponse(HELD_EXECUTION),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      render(withSession(<FactoryCommandBar initial={HELD_EXECUTION} onChanged={onChanged} />));

      fireEvent.click(screen.getByTestId('cancel-all-tasks'));
      await act(async () => {
        fireEvent.click(screen.getByTestId('cancel-all-confirm'));
      });

      expect(screen.getByTestId('factory-command-notice')).toHaveTextContent(
        'Cancelled 1 run; queued and in-flight work stops.',
      );
      expect(onChanged).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('surfaces a rejected command as a dismissible error banner (no parent refresh)', async () => {
    const onChanged = vi.fn();
    const fetchMock = vi.fn((input: RequestInfo | URL) =>
      Promise.resolve(
        String(input) === '/api/execution/resume'
          ? jsonResponse(
              {
                error: 'execution_disabled',
                message: 'Execution controls are not enabled on this server instance.',
              },
              503,
            )
          : jsonResponse(HELD_EXECUTION),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      render(withSession(<FactoryCommandBar initial={HELD_EXECUTION} onChanged={onChanged} />));

      await act(async () => {
        fireEvent.click(screen.getByTestId('factory-resume'));
      });

      const error = screen.getByTestId('factory-command-error');
      expect(error).toHaveTextContent(
        'Execution controls are not enabled on this server instance.',
      );
      expect(onChanged).not.toHaveBeenCalled();

      fireEvent.click(within(error).getByRole('button', { name: 'Dismiss' }));
      expect(screen.queryByTestId('factory-command-error')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a resume that leaves the daemon loop stopped surfaces the not-draining notice', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) =>
      Promise.resolve(
        String(input) === '/api/execution/resume'
          ? // The gate released, but the daemon loop is dead: nothing drains.
            jsonResponse({ resumed: true, held: false, running: false })
          : jsonResponse(HELD_EXECUTION),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      render(withSession(<FactoryCommandBar initial={HELD_EXECUTION} />));

      await act(async () => {
        fireEvent.click(screen.getByTestId('factory-resume'));
      });

      expect(screen.getByTestId('factory-command-notice')).toHaveTextContent(
        /daemon is not running — queued work will not drain/,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('ignores a command that settles after unmount (no onChanged, no state update)', async () => {
    let settle: (response: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => {
      settle = resolve;
    });
    const fetchMock = vi.fn(() => pending);
    vi.stubGlobal('fetch', fetchMock);
    const onChanged = vi.fn();
    try {
      const { unmount } = render(
        withSession(<FactoryCommandBar initial={HELD_EXECUTION} onChanged={onChanged} />),
      );
      fireEvent.click(screen.getByTestId('factory-resume'));
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // The operator navigates away while the resume is in flight…
      unmount();
      await act(async () => {
        settle(jsonResponse({ resumed: true, held: false, running: true }));
      });

      // …so the late result must not trigger the parent refresh (or setState).
      expect(onChanged).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
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
    expect(within(items[0]).getByRole('link', { name: /open ledger evidence/i })).toHaveAttribute(
      'href',
      '/runs/run-alpha',
    );
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

  it('resets the run filter to all when the filtered run leaves the snapshot', async () => {
    const alpha = interventionItemsOf(buildFullFactoryRunEvents('run-alpha'));
    const onlyAlpha: InterventionQueueSnapshot = { interventions: alpha, openCount: alpha.length };

    const { rerender } = render(withSession(<InterventionQueue snapshot={twoRunQueue()} />));
    const runFilter = screen.getByLabelText('Filter interventions by run');
    fireEvent.change(runFilter, { target: { value: 'run-beta' } });
    expect(screen.getByTestId('intervention-item')).toHaveAttribute('data-run-id', 'run-beta');

    // run-beta disappears from the polled snapshot: a stale filter must not
    // silently hide every remaining item — it resets to 'all'.
    rerender(withSession(<InterventionQueue snapshot={onlyAlpha} />));
    await waitFor(() =>
      expect(screen.getByLabelText('Filter interventions by run')).toHaveValue('all'),
    );
    expect(screen.getByTestId('intervention-item')).toHaveAttribute('data-run-id', 'run-alpha');
  });

  /** Live wiring exactly as FactoryFloor uses it: hook snapshot + refresh. */
  function LiveQueueHarness({ initial }: { readonly initial: InterventionQueueSnapshot }) {
    const queue = useInterventionQueue(initial);
    return <InterventionQueue snapshot={queue.snapshot} onResolved={queue.refresh} />;
  }

  it('flips a resolved item within one round trip — never waiting a full poll interval', async () => {
    vi.useFakeTimers();
    try {
      const items = interventionItemsOf(buildFullFactoryRunEvents('run-live'));
      const open: InterventionQueueSnapshot = { interventions: items, openCount: items.length };
      const resolved: InterventionQueueSnapshot = {
        interventions: items.map((item) => ({
          ...item,
          status: 'resolved' as const,
          resolution: 'credentials added',
        })),
        openCount: 0,
      };
      const fetchMock = vi.fn((input: RequestInfo | URL) =>
        Promise.resolve(
          new Response(
            JSON.stringify(
              String(input).includes('/resolve') ? { alreadyResolved: false } : resolved,
            ),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        ),
      );
      vi.stubGlobal('fetch', fetchMock);

      render(withSession(<LiveQueueHarness initial={open} />));
      fireEvent.click(screen.getByRole('button', { name: /resolve intervention/i }));
      fireEvent.change(screen.getByLabelText(/^Resolution for /), {
        target: { value: 'added the render credentials' },
      });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Record' }));
      });
      // Flush the immediate refresh poll — the fake 1.5s interval NEVER advances.
      await act(async () => {});

      expect(fetchMock).toHaveBeenCalledWith('/api/interventions', expect.anything());
      expect(screen.queryByRole('button', { name: /resolve intervention/i })).toBeNull();
      // Zero OPEN interventions is the clean state — the resolved item is
      // hidden history, not a "nothing matches your filters" puzzle.
      expect(screen.getByTestId('interventions-empty')).toHaveTextContent(/nothing needs you/i);
      expect(screen.getByTestId('interventions-empty')).toHaveTextContent(/1 resolved/i);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
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

  /** True when `a` renders before `b` in document order. */
  const before = (a: Element, b: Element): boolean =>
    (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

  function renderFloor(initialExecution?: ExecutionOverview) {
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
          initialExecution={initialExecution}
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

    expect(before(interventions, blueprint)).toBe(true);
    expect(before(blueprint, intake)).toBe(true);
    expect(before(intake, history)).toBe(true);

    // The blueprint region includes the contract handoff with commands adjacent.
    expect(screen.getByLabelText('Build contract and preflight')).toBeInTheDocument();
    expect(screen.getByTestId('run-command-bar')).toBeInTheDocument();
  });

  it('renders the factory execution gate ABOVE the interventions when execution is enabled', () => {
    renderFloor({
      execution: { enabled: true, held: true, running: true },
      queue: { queued: 1, leased: 0 },
    });

    // The drain gate outranks even the intervention queue: nothing runs until
    // the operator resumes, so the gate is the first thing on the floor.
    const controls = screen.getByLabelText('Factory execution controls');
    const interventions = screen.getByLabelText('Operator interventions');
    expect(before(controls, interventions)).toBe(true);

    // The held state is explicit: banner text plus the single Resume affordance.
    expect(screen.getByTestId('factory-held-banner')).toHaveTextContent(
      /Execution is held — nothing runs automatically/,
    );
    expect(screen.getByTestId('factory-resume')).toHaveTextContent('Resume execution');
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

  it('switching focus remounts the blueprint: the loading state shows, never the previous run', async () => {
    const runA = 'run-key-a';
    const runB = 'run-key-b';
    const aggregateA = aggregateFromEvents(buildFullFactoryRunEvents(runA), runA);
    const runProjectionB = projectRun(buildMarketplaceRunEvents(runB), runB);

    // Neither run is the server-provided latest, so each focus fetches its
    // aggregate: run A's fetch resolves; run B's stays pending forever.
    const fetchMock = vi.fn((input: RequestInfo | URL) =>
      String(input).includes(`/data/runs/${runA}`)
        ? Promise.resolve(
            new Response(JSON.stringify(aggregateA), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
          )
        : new Promise<Response>(() => {}),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      render(
        withSession(
          <FactoryFloor
            initialRuns={[aggregateA.run, runProjectionB]}
            setup={setup}
            latest={null}
          />,
        ),
      );
      expect(await screen.findByTestId('blueprint-run')).toHaveTextContent(/run-key-a/);

      fireEvent.click(
        within(screen.getByLabelText('Runs')).getByRole('button', { name: `Focus run ${runB}` }),
      );

      // key={focusedRunId}: the previous run's fetched blueprint can never
      // flash through — the keyed remount shows the honest loading state.
      expect(screen.queryByTestId('blueprint-run')).toBeNull();
      expect(screen.getByTestId('blueprint-loading')).toHaveTextContent(/Loading run run-key-b/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('Failed rehearsal presentation + per-run decisions', () => {
  const FAILED_PREFLIGHT = {
    status: 'failed' as const,
    attempt: 1,
    checks: [
      { check: 'dag', ok: true, detail: '1 ticket(s) form a valid dependency DAG.' },
      {
        check: 'workspace',
        ok: false,
        reason: 'The run requests a source workspace that has not been materialized.',
        requiredAction: 'Materialize the workspace first (POST /api/runs/:id/workspace).',
      },
      {
        check: 'approvals',
        ok: false,
        reason: 'The plan requires human triage before any build execution.',
        requiredAction:
          'Complete triage for this run (resolve the request scope), then re-plan and start.',
      },
    ],
    failedChecks: ['workspace', 'approvals'],
  };

  const OPEN_DECISIONS: BlockedStageView[] = [
    {
      interventionId: 'run-test:preflight:workspace:1',
      kind: 'source_choice',
      blockingStage: 'preflight',
      severity: 'warn',
      reason: 'The run requests a source workspace that has not been materialized.',
      requiredAction: 'Materialize the workspace first (POST /api/runs/:id/workspace).',
      approvable: false,
    },
    {
      interventionId: 'run-test:preflight:approvals:1',
      kind: 'approval',
      blockingStage: 'preflight',
      severity: 'warn',
      reason: 'The plan requires human triage before any build execution.',
      requiredAction:
        'Complete triage for this run (resolve the request scope), then re-plan and start.',
      approvable: true,
    },
  ];

  it('summarizes a failed rehearsal and separates each reason from its fix', () => {
    render(<ContractHandoff contract={undefined} preflight={FAILED_PREFLIGHT} />);

    const summary = screen.getByTestId('preflight-summary');
    expect(summary).toHaveTextContent('2 of 3 checks blocked this run.');
    expect(summary).toHaveTextContent(/Apply the fix, then press Start/);

    const rows = screen.getAllByTestId('preflight-check');
    const workspace = rows.find((row) => within(row).queryByText('workspace') !== null);
    expect(workspace).toBeDefined();
    expect(
      within(workspace!).getByText(/requests a source workspace that has not been materialized/),
    ).toBeVisible();
    // The fix renders as its own labelled line, not fused into the reason.
    expect(within(workspace!).getByText('fix')).toBeVisible();
    expect(within(workspace!).getByText(/Materialize the workspace first/)).toBeVisible();
  });

  it('links a failed rehearsal to the decision surface when decisions are open', () => {
    render(
      <ContractHandoff
        contract={undefined}
        preflight={FAILED_PREFLIGHT}
        openDecisionCount={2}
        decisionsHref="#run-decisions"
      />,
    );
    const link = screen.getByTestId('preflight-decisions-link');
    expect(link).toHaveTextContent('Review 2 pending decisions');
    expect(link).toHaveAttribute('href', '#run-decisions');
  });

  it('offers no decision link on a passing rehearsal', () => {
    const { aggregate } = buildFullAggregate();
    render(
      <ContractHandoff
        contract={aggregate.run.buildContract}
        preflight={aggregate.preflight}
        openDecisionCount={0}
        decisionsHref="#run-decisions"
      />,
    );
    expect(screen.queryByTestId('preflight-summary')).toBeNull();
    expect(screen.queryByTestId('preflight-decisions-link')).toBeNull();
  });

  it('renders open interventions as decision cards with a Resolve control', () => {
    render(withSession(<RunDecisions runId="run-test" interventions={OPEN_DECISIONS} />));

    expect(screen.getByTestId('run-decisions')).toBeInTheDocument();
    const cards = screen.getAllByTestId('run-decision');
    expect(cards).toHaveLength(2);
    expect(
      within(cards[1]).getByText(/requires human triage before any build execution/),
    ).toBeVisible();
    expect(within(cards[1]).getByText(/Complete triage for this run/)).toBeVisible();
    expect(
      within(cards[1]).getByLabelText('Resolve intervention run-test:preflight:approvals:1'),
    ).toBeVisible();
  });

  it('renders nothing when no decision is pending', () => {
    render(withSession(<RunDecisions runId="run-test" interventions={[]} />));
    expect(screen.queryByTestId('run-decisions')).toBeNull();
  });

  it('offers one-click workspace materialization ONLY on the workspace decision', () => {
    render(withSession(<RunDecisions runId="run-test" interventions={OPEN_DECISIONS} />));

    const cards = screen.getAllByTestId('run-decision');
    // source_choice/preflight (the workspace check) gets the action button…
    expect(
      within(cards[0]).getByRole('button', { name: 'Materialize workspace for run run-test' }),
    ).toBeVisible();
    // …the approval (triage) decision does not.
    expect(
      within(cards[1]).queryByRole('button', { name: /Materialize workspace/ }),
    ).toBeNull();
  });

  it('posts workspace materialization to the run endpoint and reloads on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ runId: 'run-test', result: { ok: true } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const onResolved = vi.fn();
    try {
      render(
        withSession(
          <RunDecisions runId="run-test" interventions={OPEN_DECISIONS} onResolved={onResolved} />,
        ),
      );
      fireEvent.click(
        screen.getByRole('button', { name: 'Materialize workspace for run run-test' }),
      );
      await waitFor(() => expect(onResolved).toHaveBeenCalled());
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/runs/run-test/workspace',
        expect.objectContaining({ method: 'POST' }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('RunProgress (at-a-glance execution banner)', () => {
  const T = (id: string, state: string, title?: string) =>
    ({
      ticketId: id,
      title,
      dependsOn: [],
      state,
      attempts: 1,
      firstSequence: 1,
      lastSequence: 2,
    }) as unknown as import('@software-factory/core').TicketView;

  const ROW = {
    sequence: 9,
    eventId: 'evt-9',
    runId: 'run-p',
    ticketId: 'corpus-inventory',
    type: 'worker.progress',
    severity: 'info',
    timestamp: 1_700_000_000_000,
    actor: { kind: 'system', id: 'worker' },
    subject: { kind: 'ticket', id: 'corpus-inventory' },
    detail: 'Run: rg -n --hidden vault/',
  } as unknown as import('@software-factory/core').LedgerRow;

  it('shows completed count, the bar, the running ticket, and the latest action', () => {
    render(
      <RunProgress
        tickets={[
          T('a', 'completed'),
          T('b', 'completed'),
          T('corpus-inventory', 'running', 'Inventory the source corpus'),
          T('d', 'created'),
        ]}
        rows={[ROW]}
      />,
    );
    expect(screen.getByTestId('run-progress-count')).toHaveTextContent('2 of 4 tickets completed');
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '2');
    expect(screen.getByTestId('run-progress-now')).toHaveTextContent(
      'Inventory the source corpus',
    );
    expect(screen.getByTestId('run-progress-action')).toHaveTextContent('Run: rg -n --hidden');
  });

  it('renders nothing before a plan exists', () => {
    render(<RunProgress tickets={[]} rows={[]} />);
    expect(screen.queryByTestId('run-progress')).toBeNull();
  });
});

describe('RunProgress alert strip (errors + human interaction visibility)', () => {
  const NO_TICKET_ROWS: import('@software-factory/core').LedgerRow[] = [];
  const T2 = (id: string, state: string) =>
    ({
      ticketId: id,
      dependsOn: [],
      state,
      attempts: 1,
      firstSequence: 1,
      lastSequence: 2,
    }) as unknown as import('@software-factory/core').TicketView;

  it('shows a prominent alert with a Review link when decisions are open', () => {
    render(
      <RunProgress
        tickets={[T2('a', 'completed')]}
        rows={NO_TICKET_ROWS}
        executionState="blocked"
        executionReason='Post-run gate "install" failed: install failed (exit 1).'
        openDecisionCount={1}
        decisionsHref="#needs-you"
      />,
    );
    const alert = screen.getByTestId('run-progress-alert');
    expect(alert).toHaveTextContent('1 decision needs you');
    expect(alert).toHaveTextContent(/install.*failed/);
    expect(within(alert).getByRole('link', { name: 'Review now' })).toHaveAttribute(
      'href',
      '#needs-you',
    );
  });

  it('shows the blocked/failed state even without open decisions', () => {
    render(
      <RunProgress
        tickets={[T2('a', 'completed')]}
        rows={NO_TICKET_ROWS}
        executionState="failed"
        executionReason="1 ticket(s) failed: scaffold-workspace."
      />,
    );
    expect(screen.getByTestId('run-progress-alert')).toHaveTextContent('Execution failed —');
  });

  it('renders no alert while execution is healthy', () => {
    render(
      <RunProgress tickets={[T2('a', 'running')]} rows={NO_TICKET_ROWS} executionState="started" />,
    );
    expect(screen.queryByTestId('run-progress-alert')).toBeNull();
  });
});

describe('RunReport (completion report + ship-it actions)', () => {
  function completedRun(overrides: Record<string, unknown> = {}) {
    const { aggregate } = buildFullAggregate('run-report');
    return {
      ...aggregate.run,
      status: 'completed',
      githubRepo: 'https://github.com/octo/app',
      ...overrides,
    } as typeof aggregate.run;
  }

  it('summarizes the build and offers Publish to GitHub when a repo is attached', () => {
    const { aggregate } = buildFullAggregate('run-report');
    render(
      withSession(
        <RunReport
          run={completedRun()}
          tickets={aggregate.tickets}
          gates={aggregate.gates}
          rows={aggregate.run.ledger}
          deploy={aggregate.deploy}
        />,
      ),
    );
    const report = screen.getByTestId('run-report');
    expect(report).toHaveTextContent(/tickets completed/);
    expect(report).toHaveTextContent(/gates \d+ passed/);
    expect(
      within(report).getByRole('button', { name: /Publish run .* to GitHub/ }),
    ).toBeVisible();
  });

  it('publishes via the run endpoint and shows the pushed commit', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          runId: 'run-report',
          repo: 'octo/app',
          result: { pushed: true, commit: 'abc123def456', branch: 'main', noChanges: false },
        }),
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const { aggregate } = buildFullAggregate('run-report');
      render(
        withSession(
          <RunReport
            run={completedRun()}
            tickets={aggregate.tickets}
            gates={aggregate.gates}
            rows={aggregate.run.ledger}
            deploy={aggregate.deploy}
          />,
        ),
      );
      fireEvent.click(screen.getByRole('button', { name: /Publish run .* to GitHub/ }));
      await waitFor(() =>
        expect(screen.getByTestId('publish-result')).toHaveTextContent('abc123def4'),
      );
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/publish'),
        expect.objectContaining({ method: 'POST' }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('states deploy status honestly and hides entirely for unfinished runs', () => {
    const { aggregate } = buildFullAggregate('run-report');
    const { rerender } = render(
      withSession(
        <RunReport
          run={completedRun({ githubRepo: undefined })}
          tickets={aggregate.tickets}
          gates={aggregate.gates}
          rows={aggregate.run.ledger}
          deploy={{ status: 'idle' } as never}
        />,
      ),
    );
    expect(screen.getByTestId('run-report-deploy')).toHaveTextContent(/did not deploy/);
    expect(screen.getByTestId('run-report')).toHaveTextContent(/local workspace only/);

    rerender(
      withSession(
        <RunReport
          run={{ ...completedRun(), status: 'running' } as never}
          tickets={aggregate.tickets}
          gates={aggregate.gates}
          rows={aggregate.run.ledger}
          deploy={aggregate.deploy}
        />,
      ),
    );
    expect(screen.queryByTestId('run-report')).toBeNull();
  });
});

describe('RunCompletionToast + build story', () => {
  it('pops only on the running -> completed transition and scrolls to the report', () => {
    const { rerender } = render(<RunCompletionToast status="running" runId="run-t" />);
    expect(screen.queryByTestId('run-completion-toast')).toBeNull();

    rerender(<RunCompletionToast status="completed" runId="run-t" />);
    const toast = screen.getByTestId('run-completion-toast');
    expect(toast).toHaveTextContent('Run completed');
    expect(within(toast).getByRole('button', { name: 'View build report' })).toBeVisible();

    fireEvent.click(within(toast).getByRole('button', { name: 'Dismiss completion notice' }));
    expect(screen.queryByTestId('run-completion-toast')).toBeNull();
  });

  it('never pops for a run that was already completed on load', () => {
    render(<RunCompletionToast status="completed" runId="run-t2" />);
    expect(screen.queryByTestId('run-completion-toast')).toBeNull();
  });

  it('tells the build story from the ledger inside the report', () => {
    const { aggregate } = buildFullAggregate('run-story');
    render(
      withSession(
        <RunReport
          run={{ ...aggregate.run, status: 'completed' } as typeof aggregate.run}
          tickets={aggregate.tickets}
          gates={aggregate.gates}
          rows={aggregate.run.ledger}
          deploy={aggregate.deploy}
        />,
      ),
    );
    const story = screen.getByTestId('run-report-story');
    expect(story).toHaveTextContent(/build story · \d+ milestones/);
    expect(story).toHaveTextContent('Run created');
    expect(story).toHaveTextContent('Supervisor decision');
    expect(story).toHaveTextContent(/Ticket completed/);
    // Adversity is part of the story, told honestly.
    expect(story).toHaveTextContent(/Gate failed/);
  });
});

describe('RunReport per-ticket listing', () => {
  it('lists every individual ticket with state, id, and title', () => {
    const { aggregate } = buildFullAggregate('run-tickets');
    render(
      withSession(
        <RunReport
          run={{ ...aggregate.run, status: 'completed' } as typeof aggregate.run}
          tickets={aggregate.tickets}
          gates={aggregate.gates}
          rows={aggregate.run.ledger}
          deploy={aggregate.deploy}
        />,
      ),
    );
    const list = screen.getByTestId('run-report-tickets');
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(aggregate.tickets.length);
    for (const ticket of aggregate.tickets) {
      expect(within(list).getByText(ticket.ticketId)).toBeInTheDocument();
    }
  });
});
