/**
 * AI-proposed run plans (planner generalization).
 *
 * The V1 planner recognizes exactly one built-in intent; every other request
 * used to become a triage-only plan. This module lets an AI supervisor (the
 * operator's authenticated CLI adapter) PROPOSE a ticket DAG for unrecognized
 * intents — while keeping every safety property of the deterministic planner:
 *
 *  - Validation is PURE and fail-closed: a proposal that is malformed, cyclic,
 *    oversized, or low-confidence is rejected, and the caller falls back to
 *    the human-triage plan (KTD6 — never a guessed, dangerous build).
 *  - Underspecified requests are never sent to the AI at all (the caller
 *    branches on the parsed intent first).
 *  - The accepted plan is recorded on the ledger exactly like any other plan
 *    (`emitPlan`), so replay stays deterministic: the AI runs ONCE at planning
 *    time; the events are the source of truth forever after.
 */
import { buildTicketDag } from './ticket-dag';
import type { PlannedTicket, RunPlan, SupervisorDecision, TicketKind } from './planner';
import type { RunRequest } from './run-request';
import type { RiskTier } from '../events/event-types';

/** Proposals below this confidence fall back to human triage (KTD6). */
export const AI_PLAN_MIN_CONFIDENCE = 0.6;

/** Bounds that keep a proposal reviewable and executable. */
const MAX_TICKETS = 24;
const MAX_TEXT = 2000;
const TICKET_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

const TICKET_KINDS: readonly TicketKind[] = [
  'scaffold',
  'data-model',
  'api-contract',
  'marketplace-ui',
  'ai-brief',
  'provider-proposals',
  'review-acceptance',
  'admin-status',
  'tests',
  'preview',
  'package',
  'deploy',
];

const RISK_TIERS: readonly RiskTier[] = ['low', 'medium', 'high'];

/** One AI-proposed ticket, already normalized by validation. */
export interface AiTicketProposal {
  readonly id: string;
  readonly title: string;
  readonly kind: TicketKind;
  readonly description: string;
  readonly dependsOn: readonly string[];
  readonly riskTier: RiskTier;
}

/** A validated AI plan proposal. */
export interface AiPlanProposal {
  readonly confidence: number;
  readonly rationale: string;
  readonly tickets: readonly AiTicketProposal[];
}

export type AiPlanValidation =
  | { readonly ok: true; readonly proposal: AiPlanProposal }
  | { readonly ok: false; readonly reason: string };

function clampText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Validate a raw (JSON-parsed) AI plan proposal, fail-closed. Normalization is
 * limited to what stays honest: text trimming/capping, unknown ticket kinds
 * coerced to `scaffold` (kinds are semantic labels, not behavior), unknown
 * risk tiers coerced to `medium`, and `deploy` tickets floored to `high` risk.
 * Structural problems (bad ids, missing deps, cycles, a reserved `triage` id,
 * out-of-range confidence) REJECT the proposal — never guessed around.
 */
export function validateAiPlanProposal(raw: unknown): AiPlanValidation {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'The proposal is not a JSON object.' };
  }
  const record = raw as Record<string, unknown>;

  const confidence = record.confidence;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) {
    return { ok: false, reason: 'The proposal has no numeric confidence.' };
  }
  if (confidence < 0 || confidence > 1) {
    return { ok: false, reason: `Confidence ${confidence} is outside [0, 1].` };
  }

  const rationale = clampText(record.rationale, MAX_TEXT) ?? 'No rationale provided.';

  if (!Array.isArray(record.tickets) || record.tickets.length === 0) {
    return { ok: false, reason: 'The proposal contains no tickets.' };
  }
  if (record.tickets.length > MAX_TICKETS) {
    return {
      ok: false,
      reason: `The proposal contains ${record.tickets.length} tickets (max ${MAX_TICKETS}).`,
    };
  }

  const tickets: AiTicketProposal[] = [];
  const seenIds = new Set<string>();
  for (const [index, entry] of record.tickets.entries()) {
    if (typeof entry !== 'object' || entry === null) {
      return { ok: false, reason: `Ticket ${index} is not an object.` };
    }
    const ticket = entry as Record<string, unknown>;
    const id = typeof ticket.id === 'string' ? ticket.id.trim() : '';
    if (!TICKET_ID_PATTERN.test(id)) {
      return { ok: false, reason: `Ticket ${index} has an invalid id "${String(ticket.id)}".` };
    }
    if (id === 'triage') {
      return { ok: false, reason: 'Ticket id "triage" is reserved for the human-triage plan.' };
    }
    if (seenIds.has(id)) {
      return { ok: false, reason: `Duplicate ticket id "${id}".` };
    }
    seenIds.add(id);

    const title = clampText(ticket.title, 200);
    const description = clampText(ticket.description, MAX_TEXT);
    if (title === null || description === null) {
      return { ok: false, reason: `Ticket "${id}" is missing a title or description.` };
    }

    const kind: TicketKind = TICKET_KINDS.includes(ticket.kind as TicketKind)
      ? (ticket.kind as TicketKind)
      : 'scaffold';

    let riskTier: RiskTier = RISK_TIERS.includes(ticket.riskTier as RiskTier)
      ? (ticket.riskTier as RiskTier)
      : 'medium';
    if (kind === 'deploy') {
      riskTier = 'high';
    }

    const dependsOnRaw = Array.isArray(ticket.dependsOn) ? ticket.dependsOn : [];
    const dependsOn: string[] = [];
    for (const dep of dependsOnRaw) {
      if (typeof dep !== 'string' || dep.trim().length === 0) {
        return { ok: false, reason: `Ticket "${id}" has a non-string dependency.` };
      }
      dependsOn.push(dep.trim());
    }
    if (dependsOn.includes(id)) {
      return { ok: false, reason: `Ticket "${id}" depends on itself.` };
    }

    tickets.push({ id, title, kind, description, dependsOn, riskTier });
  }

  for (const ticket of tickets) {
    for (const dep of ticket.dependsOn) {
      if (!seenIds.has(dep)) {
        return {
          ok: false,
          reason: `Ticket "${ticket.id}" depends on unknown ticket "${dep}".`,
        };
      }
    }
  }

  try {
    buildTicketDag(tickets.map((ticket) => ({ id: ticket.id, dependsOn: ticket.dependsOn })));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `The proposed tickets do not form a valid DAG: ${message}` };
  }

  return { ok: true, proposal: { confidence, rationale, tickets } };
}

/**
 * Turn a validated proposal into a `RunPlan`, or `null` when its confidence is
 * below `AI_PLAN_MIN_CONFIDENCE` (the caller falls back to human triage —
 * KTD6: low confidence routes to a human, never a guessed build).
 */
export function planFromAiProposal(
  request: RunRequest,
  proposal: AiPlanProposal,
  plannerSource: string,
): RunPlan | null {
  if (proposal.confidence < AI_PLAN_MIN_CONFIDENCE) {
    return null;
  }

  const tickets: PlannedTicket[] = proposal.tickets.map((ticket) => ({
    id: ticket.id,
    title: ticket.title,
    kind: ticket.kind,
    description: ticket.description,
    dependsOn: ticket.dependsOn,
    riskTier: ticket.riskTier,
  }));

  const elevated = tickets
    .filter((ticket) => ticket.riskTier !== 'low')
    .map((ticket) => `${ticket.id} (${ticket.riskTier})`);

  const decisions: SupervisorDecision[] = [
    {
      decision: 'classify-intent',
      rationale: `No built-in intent matched; the plan was proposed by the ${plannerSource} supervisor from the operator request. Rationale: ${proposal.rationale}`,
      confidence: proposal.confidence,
    },
    {
      decision: 'plan-run',
      rationale: `Composed ${tickets.length} AI-proposed ticket(s). Review mode: ${request.reviewMode}. Elevated-risk tickets: ${elevated.length > 0 ? elevated.join(', ') : 'none'}.`,
      confidence: proposal.confidence,
    },
  ];

  return { intent: request.intent, tickets, decisions };
}
