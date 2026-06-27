/**
 * Provenance bundle (U9) — pure assembly + completeness.
 *
 * Asserts the bundle includes every required section (source prompt/PRD, ticket
 * plan, events, adapter metadata, gate evidence, generated files, dependency
 * decisions, preview result, deploy config, and confidence), that ledger-derived
 * sections (adapters, gate evidence, preview, reduced-trust) are filled from the
 * events when not supplied, and that completeness drops as sections go missing.
 */
import { describe, expect, it } from 'vitest';
import {
  assembleProvenanceBundle,
  computeArtifactConfidence,
  createInMemoryEventStore,
  provenanceCompleteness,
} from '../../src/index';
import type {
  AssembleProvenanceInput,
  EventStore,
  FactoryEvent,
  ProvenanceDependencyDecision,
} from '../../src/index';

async function buildEventLog(): Promise<{ store: EventStore; events: FactoryEvent[] }> {
  const store = createInMemoryEventStore({
    idGenerator: (() => {
      let n = 0;
      return () => `evt-${(n += 1)}`;
    })(),
    clock: (() => {
      let t = 1_700_000_000_000;
      return () => (t += 1000);
    })(),
  });

  const runId = 'run-prov';
  await store.append({
    runId,
    type: 'run.created',
    actor: { kind: 'system', id: 'sys' },
    subject: { kind: 'run', id: runId },
    severity: 'info',
    payload: { prompt: 'Build an AI services marketplace', prdRef: 'PRD.docx' },
  });
  await store.append({
    runId,
    ticketId: 'T1',
    type: 'adapter.selected',
    actor: { kind: 'adapter', id: 'codex-cli' },
    subject: { kind: 'adapter', id: 'codex-cli' },
    severity: 'info',
    payload: { adapterId: 'codex-cli', family: 'codex' },
  });
  await store.append({
    runId,
    ticketId: 'T1',
    type: 'sandbox.fallback',
    actor: { kind: 'sandbox', id: 'sandbox' },
    subject: { kind: 'sandbox', id: 'sandbox' },
    severity: 'warn',
    payload: { reason: 'Docker unavailable; using host-local fallback.', reducedTrust: true },
  });
  await store.append({
    runId,
    ticketId: 'T1',
    type: 'gate.passed',
    actor: { kind: 'gate', id: 'gate-runner' },
    subject: { kind: 'gate', id: 'lint' },
    severity: 'success',
    evidence: [{ label: 'lint:command', ref: 'pnpm lint', note: 'lint clean' }],
    payload: { gate: 'lint', summary: 'lint passed' },
  });
  await store.append({
    runId,
    ticketId: 'T1',
    type: 'preview.ready',
    actor: { kind: 'system', id: 'preview' },
    subject: { kind: 'preview', id: runId },
    severity: 'success',
    payload: { url: 'http://127.0.0.1:3100' },
  });
  await store.append({
    runId,
    ticketId: 'T1',
    type: 'artifact.created',
    actor: { kind: 'worker', id: 'w1' },
    subject: { kind: 'artifact', id: 'app' },
    severity: 'info',
    payload: { artifactId: 'app', kind: 'repo', path: '/tmp/app' },
  });

  return { store, events: await store.readRun(runId) };
}

const DEPENDENCY_DECISIONS: ProvenanceDependencyDecision[] = [
  { name: 'next', version: '15.1.4', status: 'allowed', riskTier: 'low', reason: 'allow-listed' },
  { name: 'prisma', version: '6.1.0', status: 'needs_review', riskTier: 'medium', reason: 'unknown' },
];

async function fullInput(): Promise<AssembleProvenanceInput> {
  const { events } = await buildEventLog();
  const confidence = computeArtifactConfidence({
    gates: { passed: 5, total: 5 },
    testsPresent: true,
    provenanceCompleteness: 1,
    dependencyRisk: 'medium',
    sandboxFallback: true,
    previewInspected: true,
    previewHealthy: true,
  });
  return {
    runId: 'run-prov',
    artifactId: 'app',
    source: { prompt: 'Build an AI services marketplace', prdRef: 'PRD.docx', intent: 'ai-services-marketplace' },
    ticketPlan: [
      { id: 'T1', title: 'Scaffold app', moduleId: 'scaffold-app', riskTier: 'low', state: 'completed' },
      { id: 'T2', title: 'Data model', moduleId: 'data-model', dependsOn: ['T1'], riskTier: 'low' },
    ],
    events,
    generatedFiles: [
      { path: 'package.json', kind: 'config' },
      { path: 'prisma/schema.prisma', kind: 'schema' },
    ],
    dependencyDecisions: DEPENDENCY_DECISIONS,
    deployConfig: {
      provider: 'render',
      serviceName: 'ai-services-marketplace',
      healthCheckPath: '/api/status',
      buildCommand: 'pnpm install && prisma migrate deploy && pnpm build',
      startCommand: 'pnpm start',
      blueprint: 'services:\n  - type: web\n',
    },
    confidence: { confidence: confidence.confidence, factors: confidence.factors },
  };
}

describe('assembleProvenanceBundle', () => {
  it('includes every required provenance section', async () => {
    const bundle = assembleProvenanceBundle(await fullInput());

    // source prompt / PRD reference
    expect(bundle.source.prompt).toContain('marketplace');
    expect(bundle.source.prdRef).toBe('PRD.docx');
    // ticket plan
    expect(bundle.ticketPlan).toHaveLength(2);
    expect(bundle.ticketPlan[1].dependsOn).toEqual(['T1']);
    // events excerpt
    expect(bundle.events.length).toBeGreaterThan(0);
    expect(bundle.events[0].type).toBe('run.created');
    // adapter metadata (derived from adapter.selected)
    expect(bundle.adapters).toEqual([{ adapterId: 'codex-cli', family: 'codex' }]);
    // gate evidence (derived from gate.passed)
    expect(bundle.gateEvidence).toEqual([
      { gate: 'lint', passed: true, command: 'pnpm lint', outputExcerpt: 'lint clean', summary: 'lint passed' },
    ]);
    // generated files
    expect(bundle.generatedFiles.map((f) => f.path)).toContain('prisma/schema.prisma');
    // dependency decisions
    expect(bundle.dependencyDecisions).toHaveLength(2);
    // preview result (derived ready)
    expect(bundle.preview.status).toBe('ready');
    expect(bundle.preview.url).toBe('http://127.0.0.1:3100');
    // deploy config
    expect(bundle.deployConfig?.provider).toBe('render');
    expect(bundle.deployConfig?.healthCheckPath).toBe('/api/status');
    // confidence
    expect(bundle.confidence.confidence).toBeGreaterThan(0);
    expect(Object.keys(bundle.confidence.factors)).toContain('gatePassRate');
    // reduced trust derived from the sandbox.fallback event
    expect(bundle.reducedTrust).toBe(true);
    expect(bundle.version).toBe(1);
  });

  it('honors explicit overrides for derived sections', async () => {
    const input = await fullInput();
    const bundle = assembleProvenanceBundle({
      ...input,
      adapters: [{ adapterId: 'claude-code', family: 'claude' }],
      preview: { status: 'failed', reason: 'health timeout' },
      reducedTrust: false,
    });
    expect(bundle.adapters).toEqual([{ adapterId: 'claude-code', family: 'claude' }]);
    expect(bundle.preview).toEqual({ status: 'failed', reason: 'health timeout' });
    expect(bundle.reducedTrust).toBe(false);
  });

  it('caps the event excerpt to the most recent N when requested', async () => {
    const input = await fullInput();
    const bundle = assembleProvenanceBundle({ ...input, maxEvents: 2 });
    expect(bundle.events).toHaveLength(2);
    // The most recent events are retained (tail), in ascending sequence.
    expect(bundle.events[0].sequence).toBeLessThan(bundle.events[1].sequence);
    expect(bundle.events[bundle.events.length - 1].type).toBe('artifact.created');
  });
});

describe('provenanceCompleteness', () => {
  it('scores a full bundle at 1.0', async () => {
    const bundle = assembleProvenanceBundle(await fullInput());
    expect(provenanceCompleteness(bundle)).toBe(1);
  });

  it('drops as sections go missing', () => {
    const partial = provenanceCompleteness({
      source: { prompt: 'x' },
      ticketPlan: [{ id: 'T1' }],
      events: [{}],
      // adapters / gateEvidence / generatedFiles / dependencyDecisions absent
      preview: { status: 'idle' }, // idle does not count as present
    });
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(1);
  });

  it('returns 0 for an empty draft', () => {
    expect(provenanceCompleteness({})).toBe(0);
  });
});
