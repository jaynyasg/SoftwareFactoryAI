/**
 * Deterministic generator for the AI Services Marketplace golden run.
 *
 * Run with: node tests/fixtures/golden-runs/_generate.mjs
 * Emits tests/fixtures/golden-runs/ai-services-marketplace.jsonl — one JSON
 * event envelope per line, contiguous per-run sequence from 1, fixed ids/clock.
 *
 * This is a recorder, kept out of the committed surface; the .jsonl IS the
 * golden artifact. See docs/runbooks/golden-run-replay.md.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const RUN_ID = 'golden-ai-services-marketplace';
const BASE_TIME = 1_700_000_000_000;

const SYSTEM = { kind: 'system', id: 'system' };
const SUPERVISOR = { kind: 'supervisor', id: 'supervisor' };
const OPERATOR = { kind: 'operator', id: 'operator' };
const WORKER = { kind: 'worker', id: 'worker' };
const GATE = { kind: 'gate', id: 'gate-runner' };
const ADAPTER = { kind: 'adapter', id: 'codex-cli' };
const SANDBOX = { kind: 'sandbox', id: 'sandbox' };
const DEPLOY = { kind: 'deploy', id: 'render' };
const GENOME = { kind: 'genome', id: 'genome' };

const events = [];
let sequence = 0;

function add(type, severity, payload, extras = {}) {
  sequence += 1;
  events.push({
    version: 1,
    eventId: `evt-${sequence}`,
    runId: RUN_ID,
    ...(extras.ticketId ? { ticketId: extras.ticketId } : {}),
    actor: extras.actor ?? SYSTEM,
    subject: extras.subject ?? { kind: 'run', id: RUN_ID },
    type,
    sequence,
    timestamp: BASE_TIME + sequence * 1000,
    severity,
    ...(extras.evidence ? { evidence: extras.evidence } : {}),
    payload,
  });
}

function ticket(id) {
  return { ticketId: id, subject: { kind: 'ticket', id } };
}

// ----------------------------------------------------------------------------
// Intake + adapter setup (with an adapter setup/auth failure that recovers)
// ----------------------------------------------------------------------------
add(
  'run.created',
  'info',
  {
    prompt:
      'Build an AI services marketplace with customer requests, AI briefs, provider proposals, and review/acceptance.',
    title: 'AI Services Marketplace',
    requestedWorkerCap: 5,
    reviewMode: 'human',
    callerFamily: 'claude',
  },
  { actor: OPERATOR, subject: { kind: 'run', id: RUN_ID, version: 0 } },
);
add(
  'supervisor.decision',
  'info',
  {
    decision: 'classify-intent',
    rationale: 'Prompt matches the AI Services Marketplace intent; planning the V1 pipeline.',
    confidence: 0.9,
  },
  { actor: SUPERVISOR },
);
add(
  'adapter.setup_required',
  'warn',
  { action: 'Authenticate the local Codex CLI before running.', reason: 'No adapter session found.' },
  { actor: ADAPTER, subject: { kind: 'adapter', id: 'codex-cli' } },
);
add(
  'adapter.auth_failed',
  'error',
  { reason: 'Codex CLI not logged in (run `codex login`).' },
  { actor: ADAPTER, subject: { kind: 'adapter', id: 'codex-cli' } },
);
add(
  'adapter.selected',
  'info',
  { adapterId: 'codex-cli', family: 'codex' },
  { actor: ADAPTER, subject: { kind: 'adapter', id: 'codex-cli' } },
);
add(
  'supervisor.decision',
  'info',
  {
    decision: 'plan-run',
    rationale: 'Composed 12 tickets from scaffold through deploy. Review mode: human.',
    confidence: 0.86,
  },
  { actor: SUPERVISOR },
);

// ----------------------------------------------------------------------------
// The 12-ticket DAG
// ----------------------------------------------------------------------------
const plan = [
  { id: 'scaffold', title: 'Scaffold the marketplace app', moduleId: 'scaffold-app', dependsOn: [], riskTier: 'low' },
  { id: 'data-model', title: 'Define the data model and migrations', moduleId: 'data-model', dependsOn: ['scaffold'], riskTier: 'medium' },
  { id: 'api-contract', title: 'Define the API contract', moduleId: 'api-contract', dependsOn: ['data-model'], riskTier: 'low' },
  { id: 'marketplace-ui', title: 'Build the marketplace request flow (UI)', moduleId: 'marketplace-ui', dependsOn: ['api-contract'], riskTier: 'low' },
  { id: 'ai-brief', title: 'Generate the AI brief', moduleId: 'ai-brief', dependsOn: ['api-contract'], riskTier: 'medium' },
  { id: 'provider-proposals', title: 'Implement provider proposals', moduleId: 'provider-proposals', dependsOn: ['api-contract'], riskTier: 'low' },
  { id: 'review-acceptance', title: 'Implement proposal review and acceptance', dependsOn: ['marketplace-ui', 'provider-proposals'], riskTier: 'low' },
  { id: 'admin-status', title: 'Build admin and status dashboards', dependsOn: ['marketplace-ui', 'ai-brief', 'provider-proposals'], riskTier: 'low' },
  { id: 'tests', title: 'Author and run quality gates', moduleId: 'qa-gates', dependsOn: ['marketplace-ui', 'ai-brief', 'provider-proposals'], riskTier: 'low' },
  { id: 'preview', title: 'Run the local preview and health check', dependsOn: ['tests'], riskTier: 'low' },
  { id: 'package', title: 'Package the repo with provenance', dependsOn: ['preview'], riskTier: 'low' },
  { id: 'deploy', title: 'Deploy to the hosted target', dependsOn: ['package'], riskTier: 'high' },
];

for (const spec of plan) {
  add(
    'ticket.created',
    'info',
    { title: spec.title, moduleId: spec.moduleId, dependsOn: spec.dependsOn, riskTier: spec.riskTier },
    ticket(spec.id),
  );
}

add('run.planned', 'info', { ticketCount: plan.length }, { actor: SUPERVISOR });
add('run.started', 'info', {}, { actor: SUPERVISOR });
add('operator.health_sample', 'info', { metric: 'cpu', value: 0.42, unit: 'ratio', status: 'ok' }, { actor: SYSTEM });
add('operator.health_sample', 'info', { metric: 'memory', value: 0.55, unit: 'ratio', status: 'ok' }, { actor: SYSTEM });
add('operator.health_sample', 'info', { metric: 'queue_wait', value: 180, unit: 'ms', status: 'ok' }, { actor: SYSTEM });

// ----------------------------------------------------------------------------
// scaffold — clean pass + first artifact
// ----------------------------------------------------------------------------
add('genome.module_selected', 'info', { moduleId: 'scaffold-app', version: '1' }, { ...ticket('scaffold'), actor: GENOME });
add('worker.started', 'info', { adapterId: 'codex-cli' }, { ...ticket('scaffold'), actor: WORKER });
add('gate.started', 'info', { gate: 'lint' }, { ...ticket('scaffold'), actor: GATE });
add('gate.passed', 'success', { gate: 'lint', summary: 'no lint errors' }, { ...ticket('scaffold'), actor: GATE });
add('worker.progress', 'info', { message: 'scaffold files written', percent: 100 }, { ...ticket('scaffold'), actor: WORKER });
add('worker.completed', 'success', { summary: 'scaffold ready' }, { ...ticket('scaffold'), actor: WORKER });
add(
  'artifact.created',
  'info',
  { artifactId: 'art-repo', kind: 'repo', path: 'generated/ai-services-marketplace/apps/web/app/page.tsx' },
  { ...ticket('scaffold') },
);
add(
  'artifact.confidence_computed',
  'info',
  {
    artifactId: 'art-repo',
    confidence: 0.72,
    factors: { gatePassRate: 0.8, provenanceCompleteness: 0.9, dependencyRisk: 0.4, previewEvidence: 0.6, sandboxTrust: 0.5 },
  },
  { ...ticket('scaffold') },
);

// ----------------------------------------------------------------------------
// data-model — sandbox fallback (reduced trust) + a gate failure + retry -> pass
// ----------------------------------------------------------------------------
add('worker.started', 'info', { adapterId: 'codex-cli' }, { ...ticket('data-model'), actor: WORKER });
add(
  'sandbox.fallback',
  'warn',
  { reason: 'Docker unavailable; running with the local reduced-trust fallback.', reducedTrust: true },
  { actor: SANDBOX },
);
add('gate.started', 'info', { gate: 'unit-test' }, { ...ticket('data-model'), actor: GATE });
add(
  'gate.failed',
  'error',
  { gate: 'unit-test', reason: '2 unit tests failing in data-model' },
  { ...ticket('data-model'), actor: GATE, evidence: [{ label: 'test output', ref: 'gates/data-model/unit-test.log' }] },
);
add('worker.retry', 'warn', { attempt: 1, reason: 'unit-test gate failed' }, { ...ticket('data-model'), actor: WORKER });
add('gate.started', 'info', { gate: 'unit-test' }, { ...ticket('data-model'), actor: GATE });
add('gate.passed', 'success', { gate: 'unit-test', summary: 'all unit tests passing' }, { ...ticket('data-model'), actor: GATE });
add('worker.completed', 'success', { summary: 'data model + migrations ready' }, { ...ticket('data-model'), actor: WORKER });

// ----------------------------------------------------------------------------
// api-contract — typecheck pass
// ----------------------------------------------------------------------------
add('worker.started', 'info', { adapterId: 'codex-cli' }, { ...ticket('api-contract'), actor: WORKER });
add('gate.started', 'info', { gate: 'typecheck' }, { ...ticket('api-contract'), actor: GATE });
add('gate.passed', 'success', { gate: 'typecheck', summary: 'tsc clean' }, { ...ticket('api-contract'), actor: GATE });
add('worker.completed', 'success', { summary: 'api contract ready' }, { ...ticket('api-contract'), actor: WORKER });

// capacity throttle: requested 5 -> adapter capacity 3
add(
  'adapter.capacity_changed',
  'warn',
  { capacity: 3, previousCapacity: 5, reason: 'CPU budget reached; throttled to 3 workers.' },
  { actor: ADAPTER, subject: { kind: 'adapter', id: 'codex-cli' } },
);
add('operator.health_sample', 'warn', { metric: 'cpu', value: 0.91, unit: 'ratio', status: 'degraded' }, { actor: SYSTEM });

// ----------------------------------------------------------------------------
// marketplace-ui / ai-brief / provider-proposals (parallel fan-out)
// ----------------------------------------------------------------------------
for (const id of ['marketplace-ui', 'ai-brief', 'provider-proposals']) {
  add('worker.started', 'info', { adapterId: 'codex-cli' }, { ...ticket(id), actor: WORKER });
}
add('worker.progress', 'info', { message: 'request flow wired', percent: 80 }, { ...ticket('marketplace-ui'), actor: WORKER });
add('worker.completed', 'success', { summary: 'request flow ready' }, { ...ticket('marketplace-ui'), actor: WORKER });
add('worker.completed', 'success', { summary: 'AI brief generation ready (deterministic fallback)' }, { ...ticket('ai-brief'), actor: WORKER });
add('worker.completed', 'success', { summary: 'provider proposals ready' }, { ...ticket('provider-proposals'), actor: WORKER });

// ----------------------------------------------------------------------------
// review-acceptance / admin-status
// ----------------------------------------------------------------------------
for (const id of ['review-acceptance', 'admin-status']) {
  add('worker.started', 'info', { adapterId: 'codex-cli' }, { ...ticket(id), actor: WORKER });
  add('worker.completed', 'success', { summary: `${id} ready` }, { ...ticket(id), actor: WORKER });
}

// ----------------------------------------------------------------------------
// tests — unit-test + secret-scan gates pass
// ----------------------------------------------------------------------------
add('worker.started', 'info', { adapterId: 'codex-cli' }, { ...ticket('tests'), actor: WORKER });
add('gate.started', 'info', { gate: 'unit-test' }, { ...ticket('tests'), actor: GATE });
add('gate.passed', 'success', { gate: 'unit-test', summary: 'suite green' }, { ...ticket('tests'), actor: GATE });
add('gate.started', 'info', { gate: 'secret-scan' }, { ...ticket('tests'), actor: GATE });
add('gate.passed', 'success', { gate: 'secret-scan', summary: 'no secrets found' }, { ...ticket('tests'), actor: GATE });
add('worker.completed', 'success', { summary: 'quality gates authored + green' }, { ...ticket('tests'), actor: WORKER });

// ----------------------------------------------------------------------------
// preview — health passes, url emitted only after health
// ----------------------------------------------------------------------------
add('worker.started', 'info', { adapterId: 'codex-cli' }, { ...ticket('preview'), actor: WORKER });
add('preview.starting', 'info', {}, { ...ticket('preview'), actor: WORKER });
add('preview.health_pending', 'info', {}, { ...ticket('preview'), actor: WORKER });
add('preview.ready', 'success', { url: 'http://127.0.0.1:4311' }, { ...ticket('preview'), actor: WORKER });
add('gate.started', 'info', { gate: 'preview-health' }, { ...ticket('preview'), actor: GATE });
add('gate.passed', 'success', { gate: 'preview-health', summary: 'health 200 OK' }, { ...ticket('preview'), actor: GATE });
add('worker.completed', 'success', { summary: 'preview healthy' }, { ...ticket('preview'), actor: WORKER });

// ----------------------------------------------------------------------------
// package — provenance bundle + handoff
// ----------------------------------------------------------------------------
add('worker.started', 'info', { adapterId: 'codex-cli' }, { ...ticket('package'), actor: WORKER });
add(
  'package.created',
  'success',
  { repoPath: 'generated/ai-services-marketplace', handoffRef: 'HANDOFF.md', summary: 'repo packaged with provenance' },
  { ...ticket('package'), actor: WORKER },
);
add(
  'artifact.created',
  'info',
  { artifactId: 'art-provenance', kind: 'provenance', path: 'generated/ai-services-marketplace/PROVENANCE.json' },
  { ...ticket('package') },
);
add(
  'artifact.confidence_computed',
  'info',
  {
    artifactId: 'art-provenance',
    confidence: 0.8,
    factors: { gatePassRate: 1, provenanceCompleteness: 1, dependencyRisk: 0.6, previewEvidence: 1, sandboxTrust: 0.5 },
  },
  { ...ticket('package') },
);
add('worker.completed', 'success', { summary: 'package + provenance ready' }, { ...ticket('package'), actor: WORKER });

// ----------------------------------------------------------------------------
// deploy — high-risk human review, then a string of deploy failures that recover
// to a healthy hosted deploy (hosted URL only after health passes)
// ----------------------------------------------------------------------------
add(
  'review.requested',
  'warn',
  { riskTier: 'high', summary: 'High-risk deploy change requires 2 approvers and is never autonomous.' },
  { actor: SUPERVISOR, subject: { kind: 'ticket', id: 'deploy', version: 1 }, ticketId: 'deploy', evidence: [{ label: 'render config', ref: 'generated/ai-services-marketplace/render.yaml' }] },
);
add(
  'review.decided',
  'success',
  { riskTier: 'high', decision: 'approved', rationale: 'Two operators approved the hosted deploy.' },
  { actor: OPERATOR, ...ticket('deploy') },
);
add('worker.started', 'info', { adapterId: 'codex-cli' }, { ...ticket('deploy'), actor: WORKER });
add(
  'deploy.setup_required',
  'warn',
  { action: 'Connect a GitHub destination before deploy.' },
  { actor: DEPLOY, ...ticket('deploy') },
);
add(
  'deploy.config_invalid',
  'error',
  { reason: 'render.yaml missing healthCheckPath.' },
  { actor: DEPLOY, ...ticket('deploy'), evidence: [{ label: 'render.yaml', ref: 'generated/ai-services-marketplace/render.yaml' }] },
);
add(
  'deploy.provider_failed',
  'error',
  { reason: 'Render build failed: exit code 1.' },
  { actor: DEPLOY, ...ticket('deploy'), evidence: [{ label: 'render build log', ref: 'deploy/render/build.log' }] },
);
add(
  'deploy.migration_failed',
  'error',
  { reason: 'prisma migrate deploy failed: relation "ServiceRequest" already exists.' },
  { actor: DEPLOY, ...ticket('deploy'), evidence: [{ label: 'migrate log', ref: 'deploy/render/migrate.log' }] },
);
add('deploy.health_pending', 'info', {}, { actor: DEPLOY, ...ticket('deploy') });
add(
  'deploy.health_failed',
  'error',
  { reason: 'Hosted health returned 503 after 5 attempts.' },
  { actor: DEPLOY, ...ticket('deploy'), evidence: [{ label: 'health log', ref: 'deploy/render/health.log' }] },
);
add('deploy.health_pending', 'info', {}, { actor: DEPLOY, ...ticket('deploy') });
add(
  'deploy.hosted_ready',
  'success',
  { url: 'https://ai-services-marketplace.onrender.com' },
  { actor: DEPLOY, ...ticket('deploy') },
);
add('worker.completed', 'success', { summary: 'hosted deploy live + healthy' }, { ...ticket('deploy'), actor: WORKER });

add('operator.health_sample', 'info', { metric: 'cpu', value: 0.38, unit: 'ratio', status: 'ok' }, { actor: SYSTEM });
add('run.completed', 'success', { summary: 'AI Services Marketplace generated, gated, previewed, packaged, and deployed.' }, { actor: SUPERVISOR });

// ----------------------------------------------------------------------------
const outPath = join(dirname(fileURLToPath(import.meta.url)), 'ai-services-marketplace.jsonl');
writeFileSync(outPath, events.map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf8');
console.log(`wrote ${events.length} events to ${outPath}`);
