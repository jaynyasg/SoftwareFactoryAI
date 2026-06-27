/**
 * Tiny IO + formatting helpers shared by the CLI commands.
 *
 * `CliIo` separates RESULT output (stdout) from PROGRESS/diagnostics (stderr) so
 * that `--json` keeps stdout a single clean JSON document the skill wrappers can
 * parse, while streamed events and reconnection notices go to stderr.
 */
import type { FactoryEvent } from '@software-factory/core';
import type { RunOutputs } from './run-outputs';

export interface CliIo {
  /** Final result lines (stdout). */
  out(line: string): void;
  /** Progress / diagnostics / streamed events (stderr). */
  err(line: string): void;
}

/** Default IO bound to the real process streams. */
export const processIo: CliIo = {
  out(line) {
    process.stdout.write(`${line}\n`);
  },
  err(line) {
    process.stderr.write(`${line}\n`);
  },
};

/** Default async sleep used by the streaming/poll loops (injectable in tests). */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function payloadDetail(event: FactoryEvent): string {
  const payload = event.payload as Record<string, unknown>;
  for (const key of ['reason', 'summary', 'rationale', 'action', 'url', 'message', 'decision']) {
    const value = payload[key];
    if (typeof value === 'string' && value.length > 0) {
      return ` — ${value}`;
    }
  }
  return '';
}

/** One human-readable ledger line: `#<seq> <severity> <type> [ticket] — detail`. */
export function formatEventLine(event: FactoryEvent): string {
  const ticket = event.ticketId !== undefined ? ` [${event.ticketId}]` : '';
  return `#${event.sequence} ${event.severity.padEnd(7)} ${event.type}${ticket}${payloadDetail(event)}`;
}

/** Human-readable rendering of the run artifact contract. */
export function formatRunOutputs(outputs: RunOutputs): string {
  const lines: string[] = [];
  lines.push(`Run ${outputs.runId} — ${outputs.status}`);
  if (outputs.reviewMode !== undefined) {
    lines.push(`  review mode:   ${outputs.reviewMode}`);
  }
  if (outputs.callerFamily !== undefined) {
    lines.push(`  caller family: ${outputs.callerFamily}`);
  }
  if (outputs.plannedTicketCount !== undefined) {
    lines.push(`  planned tickets: ${outputs.plannedTicketCount}`);
  }
  if (outputs.tickets.length > 0) {
    lines.push('  ticket DAG:');
    for (const ticket of outputs.tickets) {
      const deps = ticket.dependsOn.length > 0 ? ` <- ${ticket.dependsOn.join(', ')}` : '';
      const risk = ticket.riskTier !== undefined ? ` (${ticket.riskTier} risk)` : '';
      lines.push(`    - ${ticket.id} [${ticket.state}]${risk}: ${ticket.title ?? ''}${deps}`);
    }
  }
  lines.push(`  preview url:   ${outputs.previewUrl ?? '(pending)'}`);
  lines.push(`  hosted url:    ${outputs.hostedUrl ?? '(pending)'}`);
  lines.push(`  repo path:     ${outputs.repoPath ?? '(pending)'}`);
  lines.push(`  handoff:       ${outputs.handoffRef ?? '(pending)'}`);
  lines.push(`  tests:         ${outputs.tests.summary}`);
  if (outputs.artifacts.length > 0) {
    lines.push('  artifacts:');
    for (const artifact of outputs.artifacts) {
      const confidence =
        artifact.confidence !== undefined ? ` (${Math.round(artifact.confidence * 100)}% confidence)` : '';
      lines.push(`    - ${artifact.artifactId} [${artifact.kind ?? 'artifact'}]${confidence}`);
    }
  }
  lines.push(`  events url:    ${outputs.eventsUrl}`);
  if (outputs.diagnostics.length > 0) {
    lines.push(`  diagnostics:   ${outputs.diagnostics.length} (${outputs.diagnostics[0].code} …)`);
  }
  return lines.join('\n');
}
