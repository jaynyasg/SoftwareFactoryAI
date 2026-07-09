/**
 * DeployStatus — Render config validity, deploy phases, hosted health. The
 * hosted URL is shown ONLY after a `deploy.hosted_ready` event (health success);
 * setup/config/provider/migration/health failures show the reason + severity and
 * a rescue affordance (DESIGN.md §5/§6; plan R10/R14).
 */
import type { DeployView, DeployStatusValue } from '../../lib/run-view';
import { DEPLOY_STATUS_SEVERITY } from '../../lib/run-view';
import { Mono } from './primitives';

const PHASE_LABELS: Readonly<Record<DeployStatusValue, string>> = {
  idle: 'Not started',
  setup_required: 'Setup required',
  config_invalid: 'Config invalid',
  provider_failed: 'Provider failed',
  migration_failed: 'Migration failed',
  health_pending: 'Hosted health pending',
  health_failed: 'Hosted health failed',
  hosted_ready: 'Hosted & healthy',
};

export function DeployStatus({ deploy }: { readonly deploy: DeployView }) {
  return (
    <section className="panel" aria-label="Deploy status">
      <header className="panel__header">
        <h2 className="panel__title">Deploy</h2>
        <span
          className={`badge sev-${DEPLOY_STATUS_SEVERITY[deploy.status]}`}
          data-testid="deploy-phase"
        >
          <span className="badge__dot" aria-hidden="true" />
          {PHASE_LABELS[deploy.status]}
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
