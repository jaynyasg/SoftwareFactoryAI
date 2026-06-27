'use client';

/**
 * Shared presentational primitives for the control-room surfaces.
 *
 * `Mono` is the machine-data renderer (DESIGN.md §3/§8): mono font, middle-
 * truncated so long ids/paths/urls never cause horizontal scroll, with the full
 * value preserved in a `title` and a copy affordance. Badges always pair color
 * with a text label (§1/§7 — never color alone).
 */
import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import type { EventSeverity, RiskTier, TicketView } from '@software-factory/core';
import { middleTruncate, riskClass, severityClass } from '../../lib/run-view';

/* -------------------------------------------------------------------------- */
/* Machine data                                                               */
/* -------------------------------------------------------------------------- */

export function Mono({
  value,
  max = 28,
  copyable = true,
  className,
}: {
  readonly value: string;
  readonly max?: number;
  readonly copyable?: boolean;
  readonly className?: string;
}) {
  const display = middleTruncate(value, max);
  const truncated = display !== value;
  return (
    <span className={`truncate-mid mono${className ? ` ${className}` : ''}`}>
      <span className="truncate-mid__text" title={truncated ? value : undefined} data-full={value}>
        {display}
      </span>
      {copyable ? <CopyButton value={value} /> : null}
    </span>
  );
}

function CopyButton({ value }: { readonly value: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(() => {
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    if (clipboard?.writeText === undefined) {
      return;
    }
    clipboard.writeText(value).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => {
        /* clipboard denied — leave the label unchanged rather than fail loudly */
      },
    );
  }, [value]);
  return (
    <button
      type="button"
      className="copy-btn"
      onClick={onCopy}
      aria-label={`Copy ${value}`}
      title={`Copy ${value}`}
    >
      {copied ? '✓' : '⧉'}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* Badges                                                                      */
/* -------------------------------------------------------------------------- */

export function SeverityBadge({
  severity,
  label,
}: {
  readonly severity: EventSeverity;
  readonly label?: string;
}) {
  return (
    <span className={`badge ${severityClass(severity)}`}>
      <span className="badge__dot" aria-hidden="true" />
      {label ?? severity}
    </span>
  );
}

export function RiskBadge({ tier }: { readonly tier: RiskTier }) {
  return (
    <span className={`badge ${riskClass(tier)}`} data-risk={tier}>
      <span className="badge__dot" aria-hidden="true" />
      {`${tier} risk`}
    </span>
  );
}

const TICKET_STATE_SEVERITY: Readonly<Record<TicketView['state'], EventSeverity>> = {
  unknown: 'info',
  created: 'info',
  queued: 'info',
  running: 'info',
  blocked: 'warn',
  retrying: 'warn',
  completed: 'success',
  failed: 'error',
  dead_lettered: 'critical',
  cancelled: 'warn',
};

export function StateBadge({ state }: { readonly state: TicketView['state'] }) {
  return <SeverityBadge severity={TICKET_STATE_SEVERITY[state]} label={state.replace(/_/g, ' ')} />;
}

/* -------------------------------------------------------------------------- */
/* Interaction states (§6: loading / empty / error)                           */
/* -------------------------------------------------------------------------- */

export function StateBlock({
  variant,
  title,
  children,
  action,
}: {
  readonly variant: 'loading' | 'empty' | 'error';
  readonly title: string;
  readonly children?: ReactNode;
  readonly action?: ReactNode;
}) {
  if (variant === 'loading') {
    return (
      <div className="state-block" role="status" aria-live="polite">
        <span className="state-block__title">{title}</span>
        <span className="skeleton" style={{ width: '70%', alignSelf: 'center' }} />
        <span className="skeleton" style={{ width: '45%', alignSelf: 'center' }} />
      </div>
    );
  }
  return (
    <div
      className={`state-block${variant === 'error' ? ' state-block--error' : ''}`}
      role={variant === 'error' ? 'alert' : undefined}
    >
      <span className="state-block__title">{title}</span>
      {children ? <div className="muted">{children}</div> : null}
      {action}
    </div>
  );
}
