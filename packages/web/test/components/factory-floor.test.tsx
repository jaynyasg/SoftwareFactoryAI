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
import { render, screen, within } from '@testing-library/react';
import {
  projectArtifacts,
  projectOperator,
  projectRun,
  projectTickets,
} from '@software-factory/core';
import { buildMarketplaceRunEvents } from '../../../../tests/fixtures/marketplace-run';
import { deriveDeploy, derivePreview, deriveReviews } from '../../src/lib/run-view';
import type { RunAggregate, SetupStatus } from '../../src/lib/types';
import { SessionProvider } from '../../src/components/session-context';
import { SupervisorPanel } from '../../src/components/factory-floor/SupervisorPanel';
import { WorkerBoard } from '../../src/components/factory-floor/WorkerBoard';
import { TicketCard } from '../../src/components/factory-floor/TicketCard';
import { TraceLedger } from '../../src/components/factory-floor/TraceLedger';
import { ArtifactConfidence } from '../../src/components/factory-floor/ArtifactConfidence';
import { DeployStatus } from '../../src/components/factory-floor/DeployStatus';
import { SetupChecklist } from '../../src/components/factory-floor/SetupChecklist';
import { RunControl } from '../../src/components/factory-floor/RunControl';
import { RunView } from '../../src/components/factory-floor/RunView';
import { FactoryFloor } from '../../src/components/factory-floor/FactoryFloor';
import { Mono } from '../../src/components/factory-floor/primitives';

const SESSION = { operatorToken: 'tok-test', csrfToken: 'csrf-test' };

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={typeof href === 'string' ? href : '#'}>{children}</a>
  ),
}));

function buildAggregate(runId = 'run-test'): { aggregate: RunAggregate } {
  const events = buildMarketplaceRunEvents(runId);
  const run = projectRun(events, runId);
  const aggregate: RunAggregate = {
    run,
    tickets: projectTickets(events, runId).tickets,
    artifacts: projectArtifacts(events, runId).artifacts,
    operator: projectOperator(events, runId),
    preview: derivePreview(events),
    deploy: deriveDeploy(events),
    reviews: deriveReviews(events),
    lastSequence: run.lastSequence,
    tail: run.ledger,
  };
  return { aggregate };
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
  it('exposes a 1..10 worker cap and labels it system-gated', () => {
    render(withSession(<RunControl defaultLocalFolder={'C:\\repo\\software-factory'} />));
    const cap = screen.getByLabelText('Worker cap (1–10)') as HTMLInputElement;
    expect(cap).toHaveAttribute('type', 'range');
    expect(cap).toHaveAttribute('min', '1');
    expect(cap).toHaveAttribute('max', '10');
    expect(cap).toHaveValue('10');
    expect(screen.getByLabelText('Effort budget')).toHaveValue('extra high');
    expect(screen.getByLabelText('Local folder')).toHaveValue('C:\\repo\\software-factory');
    expect(screen.getByLabelText('GitHub repository')).toBeInTheDocument();
    expect(screen.getByText('upper bound · system-gated')).toBeInTheDocument();
    expect(screen.getByLabelText('Prompt or PRD')).toBeInTheDocument();
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

    expect(screen.getByLabelText('Prompt or PRD')).toBeInTheDocument();
    expect(screen.getByLabelText('Setup checklist')).toBeInTheDocument();
    expect(screen.getByText('No runs yet.')).toBeInTheDocument();
    // Anti-slop: no fake progress in the empty state.
    expect(screen.queryByRole('progressbar')).toBeNull();
  });
});
