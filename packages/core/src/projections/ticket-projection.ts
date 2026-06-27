/**
 * Ticket projection: folds run/ticket/worker/genome events into per-ticket
 * state. Tickets are associated via the envelope `ticketId`, falling back to a
 * `ticket` subject id.
 */
import { detectSequenceGaps, resolveTargetRunId, validateAndSortEvents } from './run-projection';
import type { ProjectionDiagnostic } from './run-projection';
import type { EventSeverity, FactoryEvent, RiskTier, TicketState } from '../events/event-types';

export interface TicketView {
  readonly ticketId: string;
  readonly title?: string;
  readonly moduleId?: string;
  readonly dependsOn: string[];
  readonly riskTier?: RiskTier;
  readonly state: TicketState | 'unknown';
  readonly attempts: number;
  readonly lastSeverity?: EventSeverity;
  readonly failureReason?: string;
  readonly firstSequence: number;
  readonly lastSequence: number;
}

export interface TicketProjection {
  readonly runId: string | null;
  readonly tickets: TicketView[];
  readonly byId: Record<string, TicketView>;
  readonly diagnostics: ProjectionDiagnostic[];
}

interface MutableTicket {
  ticketId: string;
  title?: string;
  moduleId?: string;
  dependsOn: string[];
  riskTier?: RiskTier;
  state: TicketState | 'unknown';
  attempts: number;
  lastSeverity?: EventSeverity;
  failureReason?: string;
  firstSequence: number;
  lastSequence: number;
}

function resolveTicketId(event: FactoryEvent): string | undefined {
  if (event.ticketId !== undefined) {
    return event.ticketId;
  }
  if (event.subject.kind === 'ticket') {
    return event.subject.id;
  }
  return undefined;
}

function apply(ticket: MutableTicket, event: FactoryEvent): void {
  switch (event.type) {
    case 'ticket.created':
      ticket.state = 'created';
      ticket.title = event.payload.title;
      ticket.moduleId = event.payload.moduleId ?? ticket.moduleId;
      ticket.dependsOn = event.payload.dependsOn ? [...event.payload.dependsOn] : ticket.dependsOn;
      ticket.riskTier = event.payload.riskTier ?? ticket.riskTier;
      break;
    case 'ticket.queued':
      ticket.state = 'queued';
      break;
    case 'ticket.state_changed':
      ticket.state = event.payload.state;
      break;
    case 'ticket.dead_lettered':
      ticket.state = 'dead_lettered';
      ticket.failureReason = event.payload.reason;
      break;
    case 'worker.started':
      ticket.state = 'running';
      break;
    case 'worker.retry':
      ticket.state = 'retrying';
      ticket.attempts = event.payload.attempt;
      break;
    case 'worker.completed':
      ticket.state = 'completed';
      break;
    case 'worker.failed':
      ticket.state = 'failed';
      ticket.failureReason = event.payload.reason;
      break;
    case 'worker.cancelled':
      ticket.state = 'cancelled';
      ticket.failureReason = event.payload.reason ?? ticket.failureReason;
      break;
    case 'genome.module_selected':
      ticket.moduleId = event.payload.moduleId;
      break;
    default:
      break;
  }
}

function toView(ticket: MutableTicket): TicketView {
  return {
    ticketId: ticket.ticketId,
    title: ticket.title,
    moduleId: ticket.moduleId,
    dependsOn: ticket.dependsOn,
    riskTier: ticket.riskTier,
    state: ticket.state,
    attempts: ticket.attempts,
    lastSeverity: ticket.lastSeverity,
    failureReason: ticket.failureReason,
    firstSequence: ticket.firstSequence,
    lastSequence: ticket.lastSequence,
  };
}

export function projectTickets(raw: readonly unknown[], runId?: string): TicketProjection {
  const { events, diagnostics } = validateAndSortEvents(raw);
  const targetRunId = resolveTargetRunId(events, runId);
  const runEvents = targetRunId === null ? [] : events.filter((e) => e.runId === targetRunId);
  diagnostics.push(...detectSequenceGaps(runEvents));

  const map = new Map<string, MutableTicket>();
  for (const event of runEvents) {
    const ticketId = resolveTicketId(event);
    if (ticketId === undefined) {
      continue;
    }
    const ticket =
      map.get(ticketId) ??
      ({
        ticketId,
        dependsOn: [],
        state: 'unknown',
        attempts: 0,
        firstSequence: event.sequence,
        lastSequence: event.sequence,
      } satisfies MutableTicket);
    ticket.lastSequence = event.sequence;
    ticket.lastSeverity = event.severity;
    apply(ticket, event);
    map.set(ticketId, ticket);
  }

  const tickets = [...map.values()]
    .sort((a, b) => {
      if (a.firstSequence !== b.firstSequence) {
        return a.firstSequence - b.firstSequence;
      }
      return a.ticketId < b.ticketId ? -1 : a.ticketId > b.ticketId ? 1 : 0;
    })
    .map(toView);

  const byId: Record<string, TicketView> = {};
  for (const ticket of tickets) {
    byId[ticket.ticketId] = ticket;
  }

  return { runId: targetRunId, tickets, byId, diagnostics };
}
