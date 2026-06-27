'use client';

/**
 * DecisionCard — human approve/reject that goes THROUGH the command guard
 * (DESIGN.md §5/§6; plan R5/R12).
 *
 * Every action sends x-operator-token + x-csrf-token + the run's current
 * `expectedVersion`. A stale decision (the projected version moved underneath the
 * operator) comes back 409; the card then reloads the current projected state and
 * explains what happened instead of silently re-submitting. Both actions are
 * keyboard-operable and expose the risk tier and run in their accessible names
 * for screen readers (§7).
 */
import { useState } from 'react';
import type { EventEvidence, ReviewDecision, ReviewMode, RiskTier } from '@software-factory/core';
import { useSession } from '../session-context';
import { submitReview } from '../../lib/api-client';
import { riskClass, riskLabel } from '../../lib/run-view';
import { Mono } from './primitives';

type Phase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'decided'; readonly decision: ReviewDecision; readonly approvals: number }
  | { readonly kind: 'stale'; readonly message: string }
  | { readonly kind: 'error'; readonly message: string };

export function DecisionCard({
  runId,
  riskTier,
  expectedVersion,
  reviewMode,
  summary,
  evidence = [],
  onReload,
}: {
  readonly runId: string;
  readonly riskTier: RiskTier;
  readonly expectedVersion: number;
  readonly reviewMode: ReviewMode;
  readonly summary?: string;
  readonly evidence?: readonly EventEvidence[];
  readonly onReload?: () => void;
}) {
  const session = useSession();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  async function decide(decision: ReviewDecision): Promise<void> {
    setPhase({ kind: 'pending' });
    try {
      const result = await submitReview(session, runId, {
        decision,
        riskTier,
        expectedVersion,
        mode: reviewMode,
      });
      if (result.ok) {
        setPhase({ kind: 'decided', decision, approvals: result.data.requiredApprovals });
        onReload?.();
        return;
      }
      if (result.status === 409 || result.error === 'stale_subject_version') {
        // Reload current projected state, then ask the operator to review again.
        onReload?.();
        setPhase({
          kind: 'stale',
          message:
            result.message ??
            'This decision targeted an outdated version. Current state was reloaded — review the refreshed evidence and decide again.',
        });
        return;
      }
      setPhase({ kind: 'error', message: result.message ?? `Review failed (${result.error}).` });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Network error submitting review.';
      setPhase({ kind: 'error', message });
    }
  }

  const busy = phase.kind === 'pending';
  const decided = phase.kind === 'decided' ? phase : null;

  return (
    <article
      className={`decision-card decision-card--${riskTier}`}
      role="group"
      aria-label={`Review decision · ${riskLabel(riskTier)} · run ${runId}`}
    >
      <div className="ticket-card__head">
        <span className="ticket-card__title">Review decision</span>
        <span className={`badge ${riskClass(riskTier)}`} data-testid="decision-risk">
          <span className="badge__dot" aria-hidden="true" />
          {riskLabel(riskTier)}
        </span>
      </div>

      <div className="row">
        <span className="label">subject</span>
        <Mono value={runId} max={22} />
        <span className="badge mono" title="expected subject version for the stale-command guard">
          v{expectedVersion}
        </span>
      </div>

      {summary ? <p style={{ fontSize: 'var(--fs-xs)' }}>{summary}</p> : null}

      {evidence.length > 0 ? (
        <ul className="evidence-list" aria-label="evidence">
          {evidence.map((item, i) => (
            <li key={i} className="row">
              <span className="label">{item.label}</span>
              {(item.ref ?? item.href ?? item.digest) ? (
                <Mono value={(item.ref ?? item.href ?? item.digest) as string} max={28} />
              ) : item.note ? (
                <span className="muted" style={{ fontSize: 'var(--fs-2xs)' }}>
                  {item.note}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {decided ? (
        <div
          className={`banner ${decided.decision === 'approved' ? 'banner--info' : 'banner--warn'}`}
          role="status"
          data-testid="decision-outcome"
        >
          <span className="banner__body">
            Recorded: {decided.decision}.{' '}
            {decided.approvals > 0
              ? `${decided.approvals} approver(s) required at this tier.`
              : 'No human stop required under policy.'}
          </span>
        </div>
      ) : (
        <div className="decision-card__actions">
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy}
            onClick={() => void decide('approved')}
            aria-label={`Approve ${riskTier}-risk review for run ${runId}`}
          >
            {busy ? 'Submitting…' : 'Approve'}
          </button>
          <button
            type="button"
            className="btn btn--danger"
            disabled={busy}
            onClick={() => void decide('rejected')}
            aria-label={`Reject ${riskTier}-risk review for run ${runId}`}
          >
            Reject
          </button>
        </div>
      )}

      {phase.kind === 'stale' ? (
        <div className="banner banner--warn" role="alert" data-testid="decision-stale">
          <span className="banner__body">{phase.message}</span>
        </div>
      ) : null}

      {phase.kind === 'error' ? (
        <div className="banner banner--error" role="alert" data-testid="decision-error">
          <span className="banner__body">{phase.message}</span>
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={() => setPhase({ kind: 'idle' })}
          >
            Dismiss
          </button>
        </div>
      ) : null}
    </article>
  );
}
