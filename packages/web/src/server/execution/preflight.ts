/**
 * Dry-run execution rehearsal / preflight (full-factory U5, CEO expansion X2).
 *
 * Before a start command may enqueue worker execution, preflight verifies —
 * WITHOUT mutating any files — the ticket DAG, workspace readiness, write
 * scopes, credentials, adapter readiness, gate setup, deploy prerequisites,
 * and outstanding operator approvals. Every check outcome is a ledger event;
 * failed checks raise operator intervention-queue entries (X4) with concrete
 * required actions, so a blocked start is actionable rather than opaque.
 *
 * Checks derive from replayed projections plus runtime config. Individual
 * probes are injectable so tests (and later units) can harden or override
 * them; defaults fail closed where state is verifiable today. The adapter
 * readiness check is REAL (U6) when an adapter catalog is wired (run-settings
 * selection + setup detection), the gate-readiness check is REAL (U7): every
 * contract gate expectation must map to a known gate implementation, and the
 * deploy-readiness check is REAL (U8): it inspects the actual deploy runtime
 * config and states whether the deploy stage will proceed or pause with
 * setup-required — without ever blocking LOCAL execution on deploy setup (R30).
 */
import {
  PREFLIGHT_CHECKS,
  buildTicketDag,
  projectResearch,
  projectRun,
  projectTickets,
  selectExecutionAdapter,
  validateAndSortEvents,
} from '@software-factory/core';
import type {
  AdapterCatalog,
  EventStore,
  InterventionKind,
  PreflightCheck,
  ResearchProjection,
  RunProjection,
  TicketProjection,
} from '@software-factory/core';
import { projectWorkspace } from '@software-factory/worker';
import type { WorkspaceProjection } from '@software-factory/worker';
import { projectInterventions, raiseIntervention, resolveIntervention } from './interventions';
import { isKnownGateExpectation } from './gate-stages';
import { resolveDeployRuntimeConfig, resolveWorkspaceRuntimeConfig } from '../runtime';
import type { RuntimeConfig, WorkspaceRuntimeConfig } from '../runtime';

/** One check outcome inside a preflight pass. */
export interface PreflightCheckOutcome {
  readonly check: PreflightCheck;
  readonly ok: boolean;
  /** Human note for a passing check (including explicit deferral notes). */
  readonly detail?: string;
  /** Why the check failed. */
  readonly reason?: string;
  /** What the operator must do before the check can pass. */
  readonly requiredAction?: string;
  /** Intervention-queue classification for the failure (X4). */
  readonly interventionKind?: InterventionKind;
}

export interface PreflightRunResult {
  readonly attempt: number;
  readonly ok: boolean;
  readonly checks: readonly PreflightCheckOutcome[];
  readonly failedChecks: readonly PreflightCheck[];
}

/** Everything a probe may inspect. All projections are replayed, never invented. */
export interface PreflightProbeContext {
  readonly run: RunProjection;
  readonly tickets: TicketProjection;
  readonly research: ResearchProjection;
  readonly workspace: WorkspaceProjection;
  readonly workspaceConfig: WorkspaceRuntimeConfig;
  readonly runtime?: RuntimeConfig;
}

export type PreflightProbe = (
  ctx: PreflightProbeContext,
) => PreflightCheckOutcome | Promise<PreflightCheckOutcome>;

export type PreflightProbes = Readonly<Partial<Record<PreflightCheck, PreflightProbe>>>;

/**
 * A preflight runner bound to a server instance: runs one rehearsal pass for a
 * run, appending `preflight.*` events (and interventions for failures) to the
 * given store, and returns the pass result.
 */
export type PreflightRunner = (store: EventStore, runId: string) => Promise<PreflightRunResult>;

function pass(check: PreflightCheck, detail?: string): PreflightCheckOutcome {
  return { check, ok: true, detail };
}

function fail(
  check: PreflightCheck,
  reason: string,
  requiredAction: string,
  interventionKind: InterventionKind,
): PreflightCheckOutcome {
  return { check, ok: false, reason, requiredAction, interventionKind };
}

/* ----------------------------------------------------------------------------
 * Default probes
 * ------------------------------------------------------------------------- */

function probeDag(ctx: PreflightProbeContext): PreflightCheckOutcome {
  // `running` is accepted so an operator RETRY of a started-then-failed
  // execution can re-rehearse against the same planned DAG. `completed` is
  // accepted so a RETRY of a locally-complete run can re-attempt a paused or
  // failed deploy (U8/R30) — the start command already rejects completed runs
  // before preflight (`not_planned`), so this only admits retries.
  if (
    ctx.run.status !== 'planned' &&
    ctx.run.status !== 'running' &&
    ctx.run.status !== 'completed'
  ) {
    return fail(
      'dag',
      `Run status is "${ctx.run.status}", not "planned".`,
      'Plan the run before starting execution.',
      'approval',
    );
  }
  const tickets = ctx.tickets.tickets;
  if (tickets.length === 0) {
    return fail(
      'dag',
      'The run has no planned tickets.',
      'Re-create or re-plan the run so a ticket DAG exists.',
      'approval',
    );
  }
  try {
    buildTicketDag(tickets.map((t) => ({ id: t.ticketId, dependsOn: t.dependsOn })));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(
      'dag',
      `Ticket DAG is invalid: ${message}`,
      'Fix the planned ticket dependencies (re-plan the run).',
      'approval',
    );
  }
  return pass('dag', `${tickets.length} ticket(s) form a valid dependency DAG.`);
}

function probeWorkspace(ctx: PreflightProbeContext): PreflightCheckOutcome {
  const hasSource =
    (ctx.run.localFolder !== undefined && ctx.run.localFolder.length > 0) ||
    (ctx.run.githubRepo !== undefined && ctx.run.githubRepo.length > 0);
  if (!hasSource) {
    return pass(
      'workspace',
      'No source workspace requested; a fresh generated workspace is created at execution time.',
    );
  }
  switch (ctx.workspace.status) {
    case 'ready':
      return pass('workspace', 'Workspace is materialized and ready.');
    case 'unavailable':
      return fail(
        'workspace',
        ctx.workspace.unavailableReason ?? 'The requested source workspace is unavailable.',
        ctx.workspace.requiredAction ??
          'Provide a usable source (GitHub repository, uploaded PRD, or approved folder), then retry materialization.',
        ctx.workspace.unavailableSource === 'local_folder' ? 'unsafe_path' : 'source_choice',
      );
    case 'failed':
      return fail(
        'workspace',
        ctx.workspace.failureReason ?? 'Workspace materialization failed.',
        'Fix the checkout setup, then retry materialization (POST /api/runs/:id/workspace).',
        'source_choice',
      );
    case 'materializing':
      return fail(
        'workspace',
        'Workspace materialization is still in progress.',
        'Wait for materialization to conclude (or retry it), then start the run.',
        'source_choice',
      );
    case 'none':
      return fail(
        'workspace',
        'The run requests a source workspace that has not been materialized.',
        'Materialize the workspace first (POST /api/runs/:id/workspace).',
        'source_choice',
      );
    default:
      return fail(
        'workspace',
        `Unknown workspace status "${String(ctx.workspace.status)}".`,
        'Inspect the workspace ledger events for this run.',
        'source_choice',
      );
  }
}

function probeWriteScopes(ctx: PreflightProbeContext): PreflightCheckOutcome {
  const contract = ctx.run.buildContract;
  if (contract === undefined) {
    return fail(
      'write_scopes',
      'No build contract exists for this run, so write boundaries are undefined.',
      'Generate the build contract before execution (the start flow derives it for planned runs).',
      'approval',
    );
  }
  if (contract.writeBoundaries.length === 0) {
    return fail(
      'write_scopes',
      'The build contract declares no write boundaries.',
      'Re-derive the build contract with a bound workspace so write scopes are explicit.',
      'unsafe_path',
    );
  }
  return pass('write_scopes', contract.writeBoundaries.join(' '));
}

function probeCredentials(ctx: PreflightProbeContext): PreflightCheckOutcome {
  const wantsRepo = ctx.run.githubRepo !== undefined && ctx.run.githubRepo.length > 0;
  if (
    wantsRepo &&
    ctx.workspace.status !== 'ready' &&
    !ctx.workspaceConfig.checkoutCredentialsPresent
  ) {
    return fail(
      'credentials',
      `Repository ${ctx.run.githubRepo} requires checkout credentials, but none are configured.`,
      'Set SF_GIT_CHECKOUT_TOKEN in the environment that starts this server (for `pnpm dev`, packages/web/.env.local works), restart it, then retry. Checkout credentials are environment-only by design — there is no UI field, the value is never recorded — and separate from deploy/research credentials.',
      'missing_credentials',
    );
  }
  return pass('credentials', 'No missing execution credentials detected.');
}

/**
 * Real adapter readiness check (U6): resolve the adapter from the run's
 * recorded settings (or setup detection) against the catalog and probe its
 * setup. Not-ready selections fail the check with an adapter_setup
 * intervention carrying the concrete remediation.
 */
function createAdapterReadinessProbe(catalog: AdapterCatalog): PreflightProbe {
  return async (ctx: PreflightProbeContext): Promise<PreflightCheckOutcome> => {
    const selection = await selectExecutionAdapter(catalog, ctx.run.selectedAdapter);
    if (selection.ready && selection.adapter !== undefined) {
      const capacity = selection.setup?.capacity;
      return pass(
        'adapters',
        `Adapter "${selection.adapter.id}" (${selection.adapter.family}) is ${
          selection.source === 'run_settings' ? 'selected and ready' : 'detected and ready'
        }${capacity !== undefined ? ` (capacity ${capacity})` : ''}.`,
      );
    }
    return fail(
      'adapters',
      selection.reason ?? 'No execution adapter is ready on this instance.',
      selection.requiredAction ??
        'Configure and authenticate an execution adapter, then start again.',
      'adapter_setup',
    );
  };
}

function probeAdapters(ctx: PreflightProbeContext): PreflightCheckOutcome {
  // Fallback when NO adapter catalog is wired on this instance (the server
  // entry points always wire one): readiness is still enforced fail-closed at
  // execution time by the scheduler's setup probe.
  return pass(
    'adapters',
    ctx.run.selectedAdapter !== undefined
      ? `Adapter "${ctx.run.selectedAdapter}" is selected; no adapter catalog is wired on this instance, so readiness is verified fail-closed at execution time.`
      : 'No adapter catalog is wired on this instance; adapter selection and readiness are verified fail-closed at execution time.',
  );
}

/**
 * Real gate-readiness check (U7): every gate expectation the build contract
 * records must map to a known gate implementation, and the instance must have
 * gate stages enabled when expectations exist. Fails closed with an actionable
 * intervention — no deferral notes.
 */
function probeGates(ctx: PreflightProbeContext): PreflightCheckOutcome {
  const expectations = ctx.run.buildContract?.gateExpectations ?? [];
  if (expectations.length === 0) {
    return pass('gates', 'No gate expectations planned for this run.');
  }
  const unknown = expectations.filter((expectation) => !isKnownGateExpectation(expectation));
  if (unknown.length > 0) {
    return fail(
      'gates',
      `Gate expectation(s) do not map to a known gate implementation: ${unknown.join(', ')}.`,
      'Re-derive the build contract (re-plan the run) or update the gate-stage wiring so every expected gate is implemented, then start again.',
      'approval',
    );
  }
  return pass(
    'gates',
    `${expectations.length} gate expectation(s) map to configured gate stages: ${expectations.join(', ')}. Post-ticket gates run in the repair loop; post-run gates must pass before run completion.`,
  );
}

/**
 * Real deploy-readiness check (U8): inspect the ACTUAL deploy runtime config
 * (Render API key presence, service id, hosted health URL, git destination)
 * for runs that plan a deploy ticket. Missing deploy setup NEVER blocks local
 * execution (R30) — the check passes with an explicit statement that the
 * deploy stage will pause with `deploy.setup_required` until setup completes,
 * so the operator knows the hosted step's fate BEFORE starting the run.
 */
function probeDeploy(ctx: PreflightProbeContext): PreflightCheckOutcome {
  const hasDeployTicket = ctx.tickets.tickets.some((ticket) => ticket.ticketId === 'deploy');
  if (!hasDeployTicket) {
    return pass('deploy', 'No deploy ticket planned.');
  }
  const deploy = ctx.runtime?.deploy ?? resolveDeployRuntimeConfig();
  const missing: string[] = [];
  if (!deploy.renderApiKeyPresent) {
    missing.push('Render API key (RENDER_API_KEY or SF_RENDER_API_KEY)');
  }
  if (deploy.renderServiceId === undefined) {
    missing.push('Render service id (SF_RENDER_SERVICE_ID)');
  }
  if (deploy.hostedUrl === undefined) {
    missing.push('hosted health URL (SF_RENDER_HOSTED_URL)');
  }
  const hasDestination =
    (deploy.githubOwner !== undefined && deploy.githubRepo !== undefined) ||
    deploy.allowTemporaryRepo;
  if (!hasDestination) {
    missing.push(
      'git destination (SF_DEPLOY_GITHUB_OWNER + SF_DEPLOY_GITHUB_REPO, or SF_DEPLOY_ALLOW_TEMP_REPO)',
    );
  }
  if (missing.length === 0) {
    return pass(
      'deploy',
      `Deploy is ready: Render is configured (service ${deploy.renderServiceId}), the hosted health URL is set, and a git destination is resolved. The hosted URL is projected only after provider success and hosted health pass.`,
    );
  }
  return pass(
    'deploy',
    `Deploy setup is incomplete — missing: ${missing.join('; ')}. Local execution proceeds; the deploy stage will pause with deploy.setup_required (retryable) and the local package/provenance are preserved.`,
  );
}

function probeApprovals(ctx: PreflightProbeContext): PreflightCheckOutcome {
  const blockingGaps = ctx.research.gaps.filter((gap) => gap.blocking && !gap.resolved);
  if (blockingGaps.length > 0) {
    return fail(
      'approvals',
      `Blocking research gap(s) unresolved: ${blockingGaps
        .map((gap) => `${gap.question} (${gap.gapId})`)
        .join('; ')}`,
      'Resolve the blocking research gap(s) (record resolving findings or re-run research), then start again.',
      'approval',
    );
  }
  if (ctx.tickets.byId['triage'] !== undefined) {
    return fail(
      'approvals',
      'The plan requires human triage before any build execution.',
      'Resolve this triage decision (in "Decisions needed" on the run page, or "Needs you" on the factory floor) by stating the clarified scope, then create a new run with that clarified request — plans are fixed at run creation, so this run stays plan-only.',
      'approval',
    );
  }
  return pass('approvals', 'No outstanding operator approvals block execution.');
}

const DEFAULT_PROBES: Readonly<Record<PreflightCheck, PreflightProbe>> = {
  dag: probeDag,
  workspace: probeWorkspace,
  write_scopes: probeWriteScopes,
  credentials: probeCredentials,
  adapters: probeAdapters,
  gates: probeGates,
  deploy: probeDeploy,
  approvals: probeApprovals,
};

/* ----------------------------------------------------------------------------
 * Preflight projection
 * ------------------------------------------------------------------------- */

export interface PreflightCheckView {
  readonly check: PreflightCheck;
  readonly ok: boolean;
  readonly detail?: string;
  readonly reason?: string;
  readonly requiredAction?: string;
}

export interface PreflightProjection {
  readonly runId: string | null;
  /** `none` until a preflight ran; latest attempt wins thereafter. */
  readonly status: 'none' | 'running' | 'passed' | 'failed';
  readonly attempt: number;
  readonly checks: readonly PreflightCheckView[];
  readonly failedChecks: readonly PreflightCheck[];
}

/** Project the latest preflight attempt for a run. Pure and replayable. */
export function projectPreflight(raw: readonly unknown[], runId: string): PreflightProjection {
  const { events } = validateAndSortEvents(raw);
  const runEvents = events.filter((event) => event.runId === runId);

  let status: PreflightProjection['status'] = 'none';
  let attempt = 0;
  let checks: PreflightCheckView[] = [];
  let failedChecks: readonly PreflightCheck[] = [];

  for (const event of runEvents) {
    switch (event.type) {
      case 'preflight.started':
        if (event.payload.attempt >= attempt) {
          attempt = event.payload.attempt;
          status = 'running';
          checks = [];
          failedChecks = [];
        }
        break;
      case 'preflight.check_passed':
        if (event.payload.attempt === attempt) {
          checks.push({ check: event.payload.check, ok: true, detail: event.payload.detail });
        }
        break;
      case 'preflight.check_failed':
        if (event.payload.attempt === attempt) {
          checks.push({
            check: event.payload.check,
            ok: false,
            reason: event.payload.reason,
            requiredAction: event.payload.requiredAction,
          });
        }
        break;
      case 'preflight.passed':
        if (event.payload.attempt === attempt) {
          status = 'passed';
        }
        break;
      case 'preflight.failed':
        if (event.payload.attempt === attempt) {
          status = 'failed';
          failedChecks = event.payload.failedChecks;
        }
        break;
      default:
        break;
    }
  }

  return { runId: runEvents.length > 0 ? runId : null, status, attempt, checks, failedChecks };
}

/* ----------------------------------------------------------------------------
 * Runner
 * ------------------------------------------------------------------------- */

export interface RuntimePreflightOptions {
  readonly runtime?: RuntimeConfig;
  readonly clock?: () => number;
  /** Per-check probe overrides (tests, later units). */
  readonly probes?: PreflightProbes;
  /**
   * Adapter catalog for the REAL adapter readiness check (U6). When provided,
   * the `adapters` check resolves the run's adapter (run settings + setup
   * detection) and fails on a not-ready selection. Server entry points always
   * wire one; without it, readiness stays enforced at execution time.
   */
  readonly adapters?: AdapterCatalog;
}

const PREFLIGHT_ACTOR = { kind: 'system', id: 'preflight' } as const;

/**
 * Build the default preflight runner. One call = one recorded rehearsal
 * attempt: `preflight.started`, one event per check, a `passed`/`failed`
 * capstone, and an intervention-queue entry per failed check.
 */
export function createRuntimePreflight(options: RuntimePreflightOptions = {}): PreflightRunner {
  const workspaceConfig = options.runtime?.workspace ?? resolveWorkspaceRuntimeConfig();
  const probes: Readonly<Record<PreflightCheck, PreflightProbe>> = {
    ...DEFAULT_PROBES,
    ...(options.adapters !== undefined
      ? { adapters: createAdapterReadinessProbe(options.adapters) }
      : {}),
    ...options.probes,
  };

  return async (store, runId) => {
    const events = await store.readRun(runId);
    const ctx: PreflightProbeContext = {
      run: projectRun(events, runId),
      tickets: projectTickets(events, runId),
      research: projectResearch(events, runId),
      workspace: projectWorkspace(events, runId),
      workspaceConfig,
      runtime: options.runtime,
    };
    const attempt = projectPreflight(events, runId).attempt + 1;
    const subject = { kind: 'preflight', id: runId } as const;

    await store.append({
      runId,
      type: 'preflight.started',
      actor: PREFLIGHT_ACTOR,
      subject,
      severity: 'info',
      idempotencyKey: `${runId}:preflight.started:${attempt}`,
      payload: { attempt, checks: PREFLIGHT_CHECKS },
    });

    const outcomes: PreflightCheckOutcome[] = [];
    for (const check of PREFLIGHT_CHECKS) {
      const outcome = await probes[check](ctx);
      outcomes.push(outcome);
      if (outcome.ok) {
        await store.append({
          runId,
          type: 'preflight.check_passed',
          actor: PREFLIGHT_ACTOR,
          subject,
          severity: 'info',
          idempotencyKey: `${runId}:preflight.check:${check}:${attempt}`,
          payload: { attempt, check, detail: outcome.detail },
        });
      } else {
        const reason = outcome.reason ?? 'Check failed.';
        const requiredAction = outcome.requiredAction ?? 'Inspect the run and fix the setup.';
        await store.append({
          runId,
          type: 'preflight.check_failed',
          actor: PREFLIGHT_ACTOR,
          subject,
          severity: 'warn',
          idempotencyKey: `${runId}:preflight.check:${check}:${attempt}`,
          payload: { attempt, check, reason, requiredAction },
        });
        await raiseIntervention(store, {
          runId,
          interventionId: `${runId}:preflight:${check}:${attempt}`,
          kind: outcome.interventionKind ?? 'approval',
          blockingStage: 'preflight',
          reason,
          requiredAction,
        });
      }
    }

    // Supersede prior attempts' preflight entries so the queue always mirrors
    // the LATEST rehearsal: a check that now passes is no longer a decision,
    // and a check that still fails has a fresh entry for this attempt. `events`
    // was read before this attempt appended anything, so only prior-attempt
    // entries are touched — full history stays on the ledger as resolved rows.
    const priorOpen = projectInterventions(events).open.filter(
      (item) => item.runId === runId && item.blockingStage === 'preflight',
    );
    for (const item of priorOpen) {
      const outcome = outcomes.find((o) =>
        item.interventionId.startsWith(`${runId}:preflight:${o.check}:`),
      );
      await resolveIntervention(store, item, {
        resolution:
          outcome !== undefined && outcome.ok
            ? `Superseded: the "${outcome.check}" check passed on rehearsal attempt ${attempt}.`
            : `Superseded by rehearsal attempt ${attempt}${
                outcome !== undefined ? ` — see the newest "${outcome.check}" entry` : ''
              }.`,
        resolvedBy: 'preflight',
        actorKind: 'system',
      });
    }

    const failedChecks = outcomes.filter((o) => !o.ok).map((o) => o.check);
    if (failedChecks.length === 0) {
      await store.append({
        runId,
        type: 'preflight.passed',
        actor: PREFLIGHT_ACTOR,
        subject,
        severity: 'success',
        idempotencyKey: `${runId}:preflight.passed:${attempt}`,
        payload: { attempt, checkCount: outcomes.length },
      });
    } else {
      await store.append({
        runId,
        type: 'preflight.failed',
        actor: PREFLIGHT_ACTOR,
        subject,
        severity: 'error',
        idempotencyKey: `${runId}:preflight.failed:${attempt}`,
        payload: {
          attempt,
          reason: `Preflight failed: ${failedChecks.join(', ')}.`,
          failedChecks,
        },
      });
    }

    return { attempt, ok: failedChecks.length === 0, checks: outcomes, failedChecks };
  };
}
