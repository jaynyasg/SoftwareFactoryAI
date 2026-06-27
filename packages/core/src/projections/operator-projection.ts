/**
 * Operator projection: the operator-facing health/diagnostics view. Aggregates
 * health/metric samples, surfaces warn/error/critical events as alerts, and
 * tracks adapter capacity and sandbox reduced-trust fallback.
 */
import { detectSequenceGaps, resolveTargetRunId, validateAndSortEvents } from './run-projection';
import type { ProjectionDiagnostic } from './run-projection';
import type {
  EventSeverity,
  FactoryEvent,
  FactoryEventType,
  HealthStatus,
} from '../events/event-types';

export interface HealthSampleView {
  readonly metric: string;
  readonly value: number;
  readonly unit?: string;
  readonly status?: HealthStatus;
  readonly sequence: number;
  readonly timestamp: number;
}

export interface OperatorAlert {
  readonly sequence: number;
  readonly type: FactoryEventType;
  readonly severity: EventSeverity;
  readonly message: string;
  readonly ticketId?: string;
}

export interface OperatorSeverityCounts {
  readonly warn: number;
  readonly error: number;
  readonly critical: number;
}

export interface OperatorProjection {
  readonly runId: string | null;
  readonly health: HealthSampleView[];
  readonly latestByMetric: Record<string, HealthSampleView>;
  readonly alerts: OperatorAlert[];
  readonly adapterCapacity?: number;
  readonly sandboxFallback: boolean;
  readonly counts: OperatorSeverityCounts;
  readonly diagnostics: ProjectionDiagnostic[];
}

function alertMessage(event: FactoryEvent): string {
  const payload = event.payload as Record<string, unknown>;
  for (const key of ['reason', 'message', 'rationale', 'action', 'summary'] as const) {
    const value = payload[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return event.type;
}

export function projectOperator(raw: readonly unknown[], runId?: string): OperatorProjection {
  const { events, diagnostics } = validateAndSortEvents(raw);
  const targetRunId = resolveTargetRunId(events, runId);
  const runEvents = targetRunId === null ? [] : events.filter((e) => e.runId === targetRunId);
  diagnostics.push(...detectSequenceGaps(runEvents));

  const health: HealthSampleView[] = [];
  const latestByMetric: Record<string, HealthSampleView> = {};
  const alerts: OperatorAlert[] = [];
  const counts = { warn: 0, error: 0, critical: 0 };
  let adapterCapacity: number | undefined;
  let sandboxFallback = false;

  for (const event of runEvents) {
    if (event.type === 'operator.health_sample') {
      const sample: HealthSampleView = {
        metric: event.payload.metric,
        value: event.payload.value,
        unit: event.payload.unit,
        status: event.payload.status,
        sequence: event.sequence,
        timestamp: event.timestamp,
      };
      health.push(sample);
      latestByMetric[sample.metric] = sample;
    } else if (event.type === 'adapter.capacity_changed') {
      adapterCapacity = event.payload.capacity;
    } else if (event.type === 'sandbox.fallback') {
      sandboxFallback = true;
    }

    if (event.severity === 'warn' || event.severity === 'error' || event.severity === 'critical') {
      alerts.push({
        sequence: event.sequence,
        type: event.type,
        severity: event.severity,
        message: alertMessage(event),
        ticketId: event.ticketId,
      });
      counts[event.severity] += 1;
    }
  }

  return {
    runId: targetRunId,
    health,
    latestByMetric,
    alerts,
    adapterCapacity,
    sandboxFallback,
    counts,
    diagnostics,
  };
}
