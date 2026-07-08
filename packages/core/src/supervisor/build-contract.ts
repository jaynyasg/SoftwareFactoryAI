/**
 * Build contract (full-factory U3 / CEO expansion X3).
 *
 * After research + planning, the factory generates a concise contract stating
 * what execution WOULD do before any worker mutates files: scope, workspace,
 * write boundaries, risks, gate expectations, deploy target, completion
 * criteria, and the operator approvals required before execution.
 *
 * `deriveBuildContract` is PURE and derives the contract exclusively from
 * replayed projections (run + tickets + research), so the same ledger always
 * yields the same contract — including its `contractDigest`.
 *
 * `emitBuildContract` appends `contract.generated` with an idempotency key
 * containing the digest, so re-emitting is a dedup no-op UNLESS the underlying
 * research or plan changed (digest change), in which case a new contract event
 * is appended and projections take the latest.
 */
import type { RunProjection } from '../projections/run-projection';
import type { TicketProjection, TicketView } from '../projections/ticket-projection';
import type { ResearchProjection } from '../research/research-projection';
import type { ContractGeneratedPayload, RunMode } from '../events/event-types';
import type { AppendResult } from '../events/event-store';
import type { PlanEventSink } from './planner';

/** The build contract artifact. Identical to its ledger payload by design. */
export type BuildContract = ContractGeneratedPayload;

/**
 * Deterministic 64-bit FNV-1a digest (hex). Used for change detection of the
 * contract content — NOT a security hash. Pure and dependency-free so the core
 * package stays bundleable outside Node.
 */
export function contractDigest(text: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}

/**
 * Materialization evidence a caller may feed into the contract (full-factory
 * U4): when a workspace has actually been bound/checked out, the contract's
 * `workspace` + `writeBoundaries` reflect that evidence instead of the
 * "pending materialization" description derived from the run payload alone.
 */
export interface WorkspaceContractEvidence {
  /** Human-facing workspace description (repo, branch, commit, path…). */
  readonly workspace: string;
  /** Where workers are allowed to write, per the materialized workspace. */
  readonly writeBoundaries: readonly string[];
}

function describeWorkspace(run: RunProjection): { workspace: string; boundaries: string[] } {
  if (run.localFolder !== undefined && run.localFolder.length > 0) {
    return {
      workspace: `Local folder: ${run.localFolder}`,
      boundaries: [`Writes are limited to ${run.localFolder}.`],
    };
  }
  if (run.githubRepo !== undefined && run.githubRepo.length > 0) {
    return {
      workspace: `GitHub repository: ${run.githubRepo} (checkout pending workspace materialization)`,
      boundaries: [`Writes are limited to the materialized checkout of ${run.githubRepo}.`],
    };
  }
  return {
    workspace: 'No workspace bound yet; one must be materialized before execution.',
    boundaries: ['Writes are limited to the run workspace; no workspace is bound yet.'],
  };
}

function elevatedRisks(tickets: readonly TicketView[]): string[] {
  return tickets
    .filter((ticket) => ticket.riskTier !== undefined && ticket.riskTier !== 'low')
    .map((ticket) => `Elevated-risk ticket: ${ticket.ticketId} (${ticket.riskTier ?? 'unknown'})`);
}

function gateExpectationsFor(ticketIds: ReadonlySet<string>): string[] {
  const gates: string[] = [];
  if (ticketIds.has('tests')) {
    gates.push('lint', 'typecheck', 'unit and smoke tests', 'secret scan');
  }
  if (ticketIds.has('preview')) {
    gates.push('local preview health check');
  }
  return gates;
}

function completionCriteriaFor(ticketIds: ReadonlySet<string>, hasTriage: boolean): string[] {
  if (hasTriage) {
    return ['Human triage resolves the request scope before any build execution.'];
  }
  const criteria = ['All planned tickets complete.', 'All required quality gates pass.'];
  if (ticketIds.has('package')) {
    criteria.push('A packaged repo artifact with provenance exists.');
  }
  if (ticketIds.has('deploy')) {
    criteria.push('A hosted URL is projected only after provider deploy and hosted health pass.');
  }
  return criteria;
}

function operatorApprovalsFor(
  run: RunProjection,
  tickets: readonly TicketView[],
  research: ResearchProjection,
  hasTriage: boolean,
): string[] {
  const approvals: string[] = [];
  if (hasTriage) {
    approvals.push('Human triage required before any build execution.');
  }
  const elevated = tickets.filter(
    (ticket) => ticket.riskTier !== undefined && ticket.riskTier !== 'low',
  );
  if (run.reviewMode !== 'autonomous' && elevated.length > 0) {
    approvals.push(
      `Human review approval required for elevated-risk tickets: ${elevated
        .map((ticket) => `${ticket.ticketId} (${ticket.riskTier ?? 'unknown'})`)
        .join(', ')}.`,
    );
  }
  for (const gap of research.gaps) {
    if (gap.blocking && !gap.resolved) {
      approvals.push(`Resolve blocking research gap before execution: ${gap.question} (${gap.gapId})`);
    }
  }
  if (run.mode === 'research-plan-and-start') {
    // U5: the run mode IS the durable operator start request. Execution still
    // requires the dry-run preflight rehearsal (X2) to pass before the queue
    // accepts the work, so the contract records that condition explicitly.
    approvals.push(
      'Operator start approval: start request recorded (mode research-plan-and-start); execution proceeds once the dry-run preflight passes.',
    );
  }
  return approvals;
}

/**
 * Derive the build contract for a planned run from its replayed projections.
 * Pure: no clocks, randomness, or I/O — identical projections yield an
 * identical contract (and digest).
 */
export function deriveBuildContract(
  run: RunProjection,
  tickets: TicketProjection,
  research: ResearchProjection,
  workspaceEvidence?: WorkspaceContractEvidence,
): BuildContract {
  const mode: RunMode = run.mode ?? 'plan-only';
  const ticketViews = tickets.tickets;
  const ticketIds = new Set(ticketViews.map((ticket) => ticket.ticketId));
  const hasTriage = ticketIds.has('triage');
  const title = run.title ?? 'Untitled run';

  // Materialization evidence (U4) supersedes the payload-derived description.
  const { workspace, boundaries } =
    workspaceEvidence !== undefined
      ? { workspace: workspaceEvidence.workspace, boundaries: [...workspaceEvidence.writeBoundaries] }
      : describeWorkspace(run);
  const risks = elevatedRisks(ticketViews);
  for (const gap of research.gaps) {
    if (gap.blocking && !gap.resolved) {
      risks.push(`Blocking research gap: ${gap.question} (${gap.gapId})`);
    }
  }

  const researchBacked = research.status === 'completed' && research.findings.length > 0;
  const content = {
    scope: `${title} — ${ticketViews.length} planned ticket(s): ${ticketViews
      .map((ticket) => ticket.ticketId)
      .join(', ')}. Run mode: ${mode}.`,
    workspace,
    writeBoundaries: boundaries,
    risks,
    gateExpectations: gateExpectationsFor(ticketIds),
    deployTarget: ticketIds.has('deploy')
      ? 'Render (deploy config generated after local gates pass)'
      : 'none (no deploy ticket planned)',
    completionCriteria: completionCriteriaFor(ticketIds, hasTriage),
    operatorApprovals: operatorApprovalsFor(run, ticketViews, research, hasTriage),
    researchBacked,
    influencingFindingIds: research.findings.map((finding) => finding.findingId),
  };

  return { contractDigest: contractDigest(JSON.stringify(content)), ...content };
}

/**
 * Append a `contract.generated` event for the contract. Idempotent on the
 * contract digest: re-emitting an unchanged contract is a dedup no-op; a
 * changed research/plan produces a new digest and hence a new (latest-wins)
 * contract event.
 */
export async function emitBuildContract(
  sink: PlanEventSink,
  runId: string,
  contract: BuildContract,
): Promise<AppendResult> {
  return sink.append({
    runId,
    type: 'contract.generated',
    actor: { kind: 'supervisor', id: 'supervisor' },
    subject: { kind: 'run', id: runId },
    severity: 'info',
    idempotencyKey: `${runId}:contract.generated:${contract.contractDigest}`,
    payload: contract,
  });
}
