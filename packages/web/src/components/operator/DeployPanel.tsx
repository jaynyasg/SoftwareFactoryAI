/**
 * DeployPanel — hosted-deploy health for operators. Shows the folded deploy phase
 * and hosted health, every deploy FAILURE that occurred during the run (setup
 * required, config invalid, provider/migration/health failed) as its own state,
 * and the hosted URL — which appears ONLY once `hosted_ready` (health passed).
 * Read-only; values come from the operator metrics.
 */
import type { DeployPhase, HostedHealthStatus, OperatorMetrics } from '@software-factory/core';
import { Mono } from '../factory-floor/primitives';

const PHASE_LABEL: Readonly<Record<DeployPhase, string>> = {
  idle: 'Not started',
  setup_required: 'Setup required',
  config_invalid: 'Config invalid',
  provider_failed: 'Provider failed',
  migration_failed: 'Migration failed',
  health_pending: 'Hosted health pending',
  health_failed: 'Hosted health failed',
  hosted_ready: 'Hosted & healthy',
};

const PHASE_SEVERITY: Readonly<Record<DeployPhase, 'info' | 'success' | 'warn' | 'error'>> = {
  idle: 'info',
  setup_required: 'warn',
  config_invalid: 'error',
  provider_failed: 'error',
  migration_failed: 'error',
  health_pending: 'warn',
  health_failed: 'error',
  hosted_ready: 'success',
};

const HEALTH_LABEL: Readonly<Record<HostedHealthStatus, string>> = {
  not_attempted: 'not attempted',
  pending: 'pending',
  failed: 'failed',
  ready: 'ready',
};

interface FailureRow {
  readonly key: string;
  readonly testid: string;
  readonly label: string;
  readonly count: number;
  readonly severity: 'warn' | 'error';
}

export function DeployPanel({ metrics }: { readonly metrics: OperatorMetrics }) {
  const { deploy, hostedHealth } = metrics;
  const phaseSeverity = PHASE_SEVERITY[deploy.status];

  const allRows: FailureRow[] = [
    { key: 'setup', testid: 'deploy-setup-required', label: 'Setup required', count: deploy.setupRequired, severity: 'warn' },
    { key: 'config', testid: 'deploy-config-invalid', label: 'Config invalid', count: deploy.configInvalid, severity: 'error' },
    { key: 'provider', testid: 'deploy-provider-failed', label: 'Provider failed', count: deploy.providerFailed, severity: 'error' },
    { key: 'migration', testid: 'deploy-migration-failed', label: 'Migration failed', count: deploy.migrationFailed, severity: 'error' },
    { key: 'health', testid: 'deploy-health-failed', label: 'Hosted health failed', count: deploy.healthFailed, severity: 'error' },
  ];
  const failures = allRows.filter((row) => row.count > 0);

  return (
    <section className="panel" aria-label="Deploy">
      <header className="panel__header">
        <h2 className="panel__title">Deploy</h2>
        <span className={`badge sev-${phaseSeverity}`} data-testid="deploy-phase">
          <span className="badge__dot" aria-hidden="true" />
          {PHASE_LABEL[deploy.status]}
        </span>
      </header>
      <div className="panel__body">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span className="label">hosted health</span>
          <span
            className={`badge sev-${hostedHealth === 'ready' ? 'success' : hostedHealth === 'failed' ? 'error' : 'info'}`}
            data-testid="hosted-health"
          >
            {HEALTH_LABEL[hostedHealth]}
          </span>
        </div>

        <div className="stack">
          <span className="label">states encountered</span>
          {failures.length === 0 ? (
            <p className="muted">No deploy failures recorded.</p>
          ) : (
            <ul className="stack" style={{ listStyle: 'none', margin: 0, padding: 0, gap: 4 }}>
              {failures.map((row) => (
                <li key={row.key} className="row" style={{ justifyContent: 'space-between' }}>
                  <span className={`badge sev-${row.severity}`} data-testid={row.testid}>
                    <span className="badge__dot" aria-hidden="true" />
                    {row.label}
                  </span>
                  <span className="metric mono">×{row.count}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {deploy.status === 'hosted_ready' && deploy.hostedUrl ? (
          <div className="stack">
            <span className="label">hosted url</span>
            <a href={deploy.hostedUrl} target="_blank" rel="noreferrer" data-testid="hosted-url">
              <Mono value={deploy.hostedUrl} max={40} copyable />
            </a>
          </div>
        ) : (
          <p className="muted" style={{ fontSize: 'var(--fs-2xs)' }}>
            Hosted URL appears only after Render success and hosted health passes.
          </p>
        )}
      </div>
    </section>
  );
}
