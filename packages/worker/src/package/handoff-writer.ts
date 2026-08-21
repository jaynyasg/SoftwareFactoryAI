/**
 * Render the human-facing HANDOFF.md for a packaged repo.
 *
 * Pure string assembly from run/template metadata and results: what was built,
 * how to run it locally, the tests/gates summary, a pointer to the provenance
 * bundle, and the current preview + deploy status. No I/O — the repo packager
 * writes the returned string to disk.
 */
import type { ProvenanceGitDestination } from '@software-factory/core';

/** One gate's outcome for the tests summary. */
export interface GateSummaryItem {
  readonly gate: string;
  readonly passed: boolean;
  readonly summary?: string;
  readonly reason?: string;
}

/** The tests/gates summary block. */
export interface TestsSummary {
  readonly gates: readonly GateSummaryItem[];
  readonly passed: number;
  readonly total: number;
}

/** Preview/deploy status snapshots for the handoff. */
export interface StatusSnapshot {
  readonly status: string;
  readonly url?: string;
  readonly action?: string;
  readonly reason?: string;
}

/** Inputs for `renderHandoffMarkdown`. */
export interface HandoffInput {
  readonly title: string;
  readonly runId: string;
  readonly artifactId?: string;
  readonly summary?: string;
  readonly prompt?: string;
  readonly prdRef?: string;
  readonly repoPath?: string;
  readonly commit?: string;
  /** Commands to run the app locally (e.g. `pnpm install`, `pnpm db:setup`). */
  readonly howToRun?: readonly string[];
  readonly testsSummary?: TestsSummary;
  /** Repo-relative path to the provenance bundle (e.g. `PROVENANCE.json`). */
  readonly provenanceRef?: string;
  readonly preview?: StatusSnapshot;
  readonly deploy?: StatusSnapshot;
  readonly gitDestination?: ProvenanceGitDestination;
  readonly reducedTrust?: boolean;
  readonly confidence?: number;
}

/** Build a tests summary from a list of gate outcomes. */
export function summarizeGates(gates: readonly GateSummaryItem[]): TestsSummary {
  const passed = gates.filter((gate) => gate.passed).length;
  return { gates, passed, total: gates.length };
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function line(parts: string[], value: string | undefined, label: string): void {
  if (value !== undefined && value.length > 0) {
    parts.push(`- **${label}:** ${value}`);
  }
}

/** Render the handoff markdown document. */
export function renderHandoffMarkdown(input: HandoffInput): string {
  const out: string[] = [];
  out.push(`# Handoff: ${input.title}`, '');

  if (input.summary !== undefined && input.summary.length > 0) {
    out.push(input.summary, '');
  }

  out.push('## What this is', '');
  line(out, input.prompt, 'Source prompt');
  line(out, input.prdRef, 'Source PRD');
  line(out, input.runId, 'Run');
  line(out, input.artifactId, 'Artifact');
  line(out, input.commit, 'Commit');
  if (input.confidence !== undefined) {
    line(out, formatPercent(input.confidence), 'Artifact confidence');
  }
  if (input.reducedTrust === true) {
    out.push(
      '- **Trust:** ⚠️ reduced — a host-local sandbox fallback was used for at least one step.',
    );
  }
  out.push('');

  out.push('## How to run locally', '');
  const runSteps =
    input.howToRun !== undefined && input.howToRun.length > 0
      ? input.howToRun
      : ['pnpm install', 'cp .env.example .env', 'pnpm db:setup', 'pnpm dev'];
  out.push('```bash', ...runSteps, '```', '');

  if (input.testsSummary !== undefined) {
    const { passed, total, gates } = input.testsSummary;
    out.push('## Tests & gates', '', `${passed}/${total} gates passed.`, '');
    if (gates.length > 0) {
      out.push('| Gate | Result | Detail |', '| --- | --- | --- |');
      for (const gate of gates) {
        const result = gate.passed ? 'pass' : 'fail';
        const detail = (gate.passed ? gate.summary : gate.reason) ?? '';
        out.push(`| ${gate.gate} | ${result} | ${detail.replace(/\|/g, '\\|')} |`);
      }
      out.push('');
    }
  }

  if (input.provenanceRef !== undefined) {
    out.push(
      '## Provenance',
      '',
      `Full provenance (source, ticket plan, events, gate evidence, generated files, ` +
        `dependency decisions, preview, deploy config, confidence) is in ` +
        `\`${input.provenanceRef}\`.`,
      '',
    );
  }

  if (input.gitDestination !== undefined) {
    const dest = input.gitDestination;
    out.push('## Git destination', '');
    line(out, dest.remoteUrl, 'Remote');
    out.push(`- **Ownership:** ${dest.temporary ? 'factory-owned TEMPORARY' : 'user-provided'}`);
    if (dest.temporary && dest.cleanupNote !== undefined) {
      out.push(`- **Cleanup:** ${dest.cleanupNote}`);
    }
    out.push('');
  }

  out.push('## Status', '');
  if (input.preview !== undefined) {
    const previewUrl =
      input.preview.status === 'ready' && input.preview.url !== undefined
        ? ` (${input.preview.url})`
        : '';
    out.push(`- **Local preview:** ${input.preview.status}${previewUrl}`);
  }
  if (input.deploy !== undefined) {
    const deployUrl =
      input.deploy.status === 'hosted_ready' && input.deploy.url !== undefined
        ? ` (${input.deploy.url})`
        : '';
    out.push(`- **Hosted deploy:** ${input.deploy.status}${deployUrl}`);
    if (input.deploy.action !== undefined) {
      out.push(`  - action: ${input.deploy.action}`);
    }
    if (input.deploy.reason !== undefined) {
      out.push(`  - reason: ${input.deploy.reason}`);
    }
  }
  out.push('');

  return `${out.join('\n').trimEnd()}\n`;
}
