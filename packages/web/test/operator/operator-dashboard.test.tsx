// @vitest-environment jsdom
/**
 * Operator dashboard component tests (jsdom). The panels are fed by the REAL
 * core observability functions (computeOperatorMetrics / computeRunDiagnostics /
 * projectOperator) applied to the committed golden-run fixture, then asserted to
 * render every operator state the plan requires: adapter unavailable, capacity
 * throttled, sandbox fallback, gate failed, and the deploy states (setup-required,
 * provider failed, hosted health failed) — with the hosted URL shown only after
 * hosted health passes.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  computeOperatorMetrics,
  computeRunDiagnostics,
  projectOperator,
} from '@software-factory/core';
import type { FactoryEvent } from '@software-factory/core';
import { HealthPanel } from '../../src/components/operator/HealthPanel';
import { AdapterPanel } from '../../src/components/operator/AdapterPanel';
import { QueuePanel } from '../../src/components/operator/QueuePanel';
import { DeployPanel } from '../../src/components/operator/DeployPanel';

// Vitest runs with cwd = packages/web; the repo root is two levels up.
const GOLDEN_PATH = resolve(
  process.cwd(),
  '../../tests/fixtures/golden-runs/ai-services-marketplace.jsonl',
);

const RAW: FactoryEvent[] = readFileSync(GOLDEN_PATH, 'utf8')
  .split('\n')
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line) as FactoryEvent);

const metrics = computeOperatorMetrics(RAW, { now: 1_700_000_200_000 });
const operator = projectOperator(RAW);
const diagnostics = computeRunDiagnostics(RAW);

describe('AdapterPanel', () => {
  it('renders the adapter-unavailable and capacity-throttled states', () => {
    render(<AdapterPanel metrics={metrics} />);
    expect(screen.getByTestId('adapter-unavailable')).toBeInTheDocument();
    expect(screen.getByTestId('capacity-throttled')).toBeInTheDocument();
    expect(screen.getByTestId('adapter-state')).toHaveTextContent('unavailable');
    expect(screen.getByText(/capacity 3 \/ 5/)).toBeInTheDocument();
  });
});

describe('HealthPanel', () => {
  it('renders the sandbox-fallback (reduced trust) state and clean projection lag', () => {
    render(<HealthPanel metrics={metrics} operator={operator} diagnostics={diagnostics} />);
    expect(screen.getByTestId('sandbox-fallback')).toBeInTheDocument();
    expect(screen.getByTestId('projection-lag')).toHaveTextContent('0 events');
    // The reduced-trust fallback is surfaced as an active failure with its rescue.
    expect(screen.getByText(/Rescue:/)).toBeInTheDocument();
  });
});

describe('QueuePanel', () => {
  it('renders the gate-failed state and gate-retry churn', () => {
    render(<QueuePanel metrics={metrics} />);
    expect(screen.getByTestId('gate-failed')).toBeInTheDocument();
    expect(screen.getByTestId('gate-retries')).toHaveTextContent('1');
  });
});

describe('DeployPanel', () => {
  it('renders deploy setup-required, provider-failed, and hosted-health-failed states', () => {
    render(<DeployPanel metrics={metrics} />);
    expect(screen.getByTestId('deploy-setup-required')).toBeInTheDocument();
    expect(screen.getByTestId('deploy-provider-failed')).toBeInTheDocument();
    expect(screen.getByTestId('deploy-health-failed')).toBeInTheDocument();
  });

  it('shows the hosted URL only after hosted health passes', () => {
    render(<DeployPanel metrics={metrics} />);
    // The golden run recovers to hosted_ready, so the URL is present.
    expect(screen.getByTestId('deploy-phase')).toHaveTextContent('Hosted & healthy');
    expect(screen.getByTestId('hosted-health')).toHaveTextContent('ready');
    expect(screen.getByTestId('hosted-url')).toBeInTheDocument();
  });
});

describe('metrics sanity (golden run)', () => {
  it('the fixture exercises every operator failure state', () => {
    expect(metrics.adapter.authFailures).toBeGreaterThan(0);
    expect(metrics.adapter.throttled).toBe(true);
    expect(metrics.sandbox.fallback).toBe(true);
    expect(metrics.gates.failures).toBeGreaterThan(0);
    expect(metrics.deploy.setupRequired).toBeGreaterThan(0);
    expect(metrics.deploy.providerFailed).toBeGreaterThan(0);
    expect(metrics.deploy.healthFailed).toBeGreaterThan(0);
    expect(metrics.deploy.status).toBe('hosted_ready');
    expect(metrics.hostedHealth).toBe('ready');
  });
});
