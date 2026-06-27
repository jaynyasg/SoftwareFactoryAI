/**
 * DeployStatus — Render config validity, deploy phases, hosted health. The
 * hosted URL is shown ONLY after a `deploy.hosted_ready` event (health success);
 * setup/config/provider/migration/health failures show the reason + severity and
 * a rescue affordance (DESIGN.md §5/§6; plan R10/R14).
 */
import type { DeployView, DeployStatusValue } from '../../lib/run-view';
import { Mono } from './primitives';

interface PhaseMeta {
  readonly label: string;
  readonly severity: 'info' | 'success' | 'warn' | 'error';
}

const PHASES: Readonly<Record<DeployStatusValue, PhaseMeta>> = {
  idle: { label: 'Not started', severity: 'info' },
  setup_required: { label: 'Setup required', severity: 'warn' },
  config_invalid: { label: 'Config invalid', severity: 'error' },
  provider_failed: { label: 'Provider failed', severity: 'error' },
  migration_failed: { label: 'Migration failed', severity: 'error' },
  health_pending: { label: 'Hosted health pending', severity: 'warn' },
  health_failed: { label: 'Hosted health failed', severity: 'error' },
  hosted_ready: { label: 'Hosted & healthy', severity: 'success' },
};

export function DeployStatus({ deploy }: { readonly deploy: DeployView }) {
  const phase = PHASES[deploy.status];
  return (
    <section className="panel" aria-label="Deploy status">
      <header className="panel__header">
        <h2 className="panel__title">Deploy</h2>
        <span className={`badge sev-${phase.severity}`} data-testid="deploy-phase">
          <span className="badge__dot" aria-hidden="true" />
          {phase.label}
        </span>
      </header>
      <div className="panel__body">
        {deploy.status === 'idle' ? (
          <p className="muted">
            Deploy runs only after local gates, preview, and review policy pass.
          </p>
        ) : null}

        {deploy.action ? (
          <div className="banner banner--warn" role="status">
            <span className="banner__body">Action: {deploy.action}</span>
          </div>
        ) : null}

        {deploy.reason ? (
          <div className="banner banner--error" role="alert">
            <span className="banner__body">{deploy.reason}</span>
          </div>
        ) : null}

        {deploy.status === 'hosted_ready' && deploy.url ? (
          <div className="stack">
            <span className="label">hosted url</span>
            <a href={deploy.url} target="_blank" rel="noreferrer" data-testid="hosted-url">
              <Mono value={deploy.url} max={40} copyable />
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
