/**
 * ContractHandoff — the handoff between blueprint and execution (DESIGN.md §5,
 * U9; X2/X3). Renders the latest build contract as scannable structured rows
 * (scope, workspace, write boundaries, risks, gate expectations, deploy
 * target, completion criteria, operator approvals) and the dry-run preflight
 * outcome as per-check rows — never raw JSON. The run's command actions render
 * adjacent (passed in by the owner), so "review the contract → start" is one
 * surface. Honest empty states: no contract yet / not rehearsed yet.
 */
import type { ReactNode } from 'react';
import type { BuildContractView } from '@software-factory/core';
import type { PreflightSnapshot } from '../../lib/types';
import { Mono, SeverityBadge } from './primitives';

function ContractRow({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="kv" data-testid={`contract-${label.replace(/\s+/g, '-')}`}>
      <span className="label kv__label">{label}</span>
      <span className="kv__value">{children}</span>
    </div>
  );
}

function PreflightRows({ preflight }: { readonly preflight: PreflightSnapshot }) {
  if (preflight.status === 'none') {
    return (
      <p className="muted" style={{ fontSize: 'var(--fs-2xs)' }}>
        Not rehearsed yet — the dry-run rehearsal runs automatically before any start
        may enqueue execution.
      </p>
    );
  }
  return (
    <ul className="preflight-list" aria-label="Preflight checks">
      {preflight.checks.map((check) => (
        <li key={check.check} className="preflight-row" data-testid="preflight-check">
          <SeverityBadge
            severity={check.ok ? 'success' : 'error'}
            label={check.ok ? 'pass' : 'fail'}
          />
          <span className="preflight-row__name mono">{check.check.replace(/_/g, ' ')}</span>
          <span className="muted preflight-row__detail">
            {check.ok ? check.detail : `${check.reason ?? 'failed'} ${check.requiredAction ?? ''}`}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function ContractHandoff({
  contract,
  preflight,
  actions,
}: {
  readonly contract: BuildContractView | undefined;
  readonly preflight: PreflightSnapshot;
  /** The run command actions rendered adjacent to the contract (RunCommandBar). */
  readonly actions?: ReactNode;
}) {
  return (
    <section className="panel contract" aria-label="Build contract and preflight">
      <header className="panel__header">
        <h2 className="panel__title">Contract → execution</h2>
        <SeverityBadge
          severity={
            preflight.status === 'passed'
              ? 'success'
              : preflight.status === 'failed'
                ? 'error'
                : 'info'
          }
          label={
            preflight.status === 'none'
              ? 'preflight pending'
              : `preflight ${preflight.status} · attempt ${preflight.attempt}`
          }
        />
      </header>
      <div className="panel__body">
        {actions !== undefined ? <div className="contract__actions">{actions}</div> : null}

        {contract === undefined ? (
          <p className="muted" data-testid="contract-empty">
            No build contract yet — it is generated from research + planning when a
            planned run starts, and must exist before workers may mutate files.
          </p>
        ) : (
          <div className="stack contract__rows" data-testid="build-contract">
            <ContractRow label="scope">{contract.scope}</ContractRow>
            <ContractRow label="workspace">
              <Mono value={contract.workspace} max={44} />
            </ContractRow>
            <ContractRow label="write boundaries">
              <span className="row" style={{ gap: 'var(--space-4)' }}>
                {contract.writeBoundaries.length === 0 ? (
                  <span className="muted">none recorded</span>
                ) : (
                  contract.writeBoundaries.map((boundary) => (
                    <Mono key={boundary} value={boundary} max={30} copyable={false} />
                  ))
                )}
              </span>
            </ContractRow>
            <ContractRow label="risks">
              {contract.risks.length === 0 ? (
                <span className="muted">none recorded</span>
              ) : (
                <ul className="contract__list">
                  {contract.risks.map((risk) => (
                    <li key={risk}>{risk}</li>
                  ))}
                </ul>
              )}
            </ContractRow>
            <ContractRow label="gates">
              <span className="row" style={{ gap: 'var(--space-4)' }}>
                {contract.gateExpectations.length === 0 ? (
                  <span className="muted">none expected</span>
                ) : (
                  contract.gateExpectations.map((gate) => (
                    <span key={gate} className="badge">
                      {gate}
                    </span>
                  ))
                )}
              </span>
            </ContractRow>
            <ContractRow label="deploy target">
              <Mono value={contract.deployTarget} max={36} copyable={false} />
            </ContractRow>
            <ContractRow label="done means">
              {contract.completionCriteria.length === 0 ? (
                <span className="muted">none recorded</span>
              ) : (
                <ul className="contract__list">
                  {contract.completionCriteria.map((criterion) => (
                    <li key={criterion}>{criterion}</li>
                  ))}
                </ul>
              )}
            </ContractRow>
            <ContractRow label="approvals">
              {contract.operatorApprovals.length === 0 ? (
                <span className="muted">none required before execution</span>
              ) : (
                <ul className="contract__list">
                  {contract.operatorApprovals.map((approval) => (
                    <li key={approval}>{approval}</li>
                  ))}
                </ul>
              )}
            </ContractRow>
            <div className="row" style={{ gap: 'var(--space-8)' }}>
              {contract.researchBacked ? (
                <span className="badge sev-success">
                  <span className="badge__dot" aria-hidden="true" />
                  research-backed
                </span>
              ) : (
                <span className="badge">no research inputs</span>
              )}
              <span className="badge mono" title="contract digest (stable unless plan/research change)">
                {contract.contractDigest.slice(0, 12)}
              </span>
            </div>
          </div>
        )}

        <div className="stack" aria-label="Dry-run rehearsal">
          <span className="label">dry-run rehearsal</span>
          <PreflightRows preflight={preflight} />
        </div>
      </div>
    </section>
  );
}
