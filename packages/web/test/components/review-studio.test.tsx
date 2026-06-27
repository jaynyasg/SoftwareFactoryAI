// @vitest-environment jsdom
/**
 * Review Studio + Decision Card tests (jsdom). They assert the command-guarded
 * review flow: mutating calls carry the operator + CSRF tokens and an
 * expectedVersion; a 409 stale response triggers a reload and an explanation
 * instead of a blind retry; high-risk reviews are labeled "never autonomous";
 * and the actions are keyboard-operable with screen-reader-friendly names (§7).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { buildMarketplaceRunEvents } from '../../../../tests/fixtures/marketplace-run';
import { deriveReviews } from '../../src/lib/run-view';
import { projectArtifacts, projectOperator } from '@software-factory/core';
import { SessionProvider } from '../../src/components/session-context';
import { DecisionCard } from '../../src/components/factory-floor/DecisionCard';
import { ReviewStudio } from '../../src/components/factory-floor/ReviewStudio';

const SESSION = { operatorToken: 'tok-test', csrfToken: 'csrf-test' };

interface FakeResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

function fakeResponse(status: number, body: unknown): FakeResponse {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

function withSession(node: ReactElement): ReactElement {
  return <SessionProvider session={SESSION}>{node}</SessionProvider>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DecisionCard', () => {
  it('approves through the command guard with token, CSRF, and expectedVersion', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse(200, {
        decision: 'approved',
        riskTier: 'high',
        requiredApprovals: 2,
        run: {},
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const onReload = vi.fn();
    const user = userEvent.setup();

    render(
      withSession(
        <DecisionCard
          runId="run-xyz"
          riskTier="high"
          expectedVersion={38}
          reviewMode="human"
          summary="Deploy change"
          onReload={onReload}
        />,
      ),
    );

    await user.click(
      screen.getByRole('button', { name: /approve high-risk review for run run-xyz/i }),
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/runs/run-xyz/review');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-operator-token']).toBe('tok-test');
    expect(headers['x-csrf-token']).toBe('csrf-test');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.expectedVersion).toBe(38);
    expect(body.decision).toBe('approved');
    expect(body.riskTier).toBe('high');

    expect(await screen.findByTestId('decision-outcome')).toHaveTextContent('approved');
    expect(onReload).toHaveBeenCalled();
  });

  it('handles a stale subject version by reloading state and explaining', async () => {
    // No server message -> the card surfaces its own explanatory copy.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(fakeResponse(409, { error: 'stale_subject_version' }));
    vi.stubGlobal('fetch', fetchMock);
    const onReload = vi.fn();
    const user = userEvent.setup();

    render(
      withSession(
        <DecisionCard
          runId="run-xyz"
          riskTier="medium"
          expectedVersion={4}
          reviewMode="human"
          onReload={onReload}
        />,
      ),
    );

    await user.click(screen.getByRole('button', { name: /approve medium-risk review/i }));

    const stale = await screen.findByTestId('decision-stale');
    expect(stale).toHaveTextContent(/outdated version/i);
    expect(onReload).toHaveBeenCalled(); // current projected state was reloaded
    expect(screen.queryByTestId('decision-outcome')).toBeNull();
  });

  it('labels high risk as never autonomous and is keyboard operable', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse(200, {
        decision: 'rejected',
        riskTier: 'high',
        requiredApprovals: 2,
        run: {},
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(
      withSession(
        <DecisionCard runId="run-xyz" riskTier="high" expectedVersion={1} reviewMode="human" />,
      ),
    );

    const group = screen.getByRole('group', { name: /review decision/i });
    expect(group).toHaveAccessibleName(/high risk/i);
    expect(screen.getByTestId('decision-risk')).toHaveTextContent(/never autonomous/i);

    // Keyboard: focus the reject action and activate with Enter.
    const reject = screen.getByRole('button', { name: /reject high-risk review/i });
    reject.focus();
    expect(reject).toHaveFocus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });
});

describe('ReviewStudio', () => {
  it('shows trace severity, a pending high-risk decision card, and confidence breakdown', () => {
    const events = buildMarketplaceRunEvents('run-rs');
    const reviews = deriveReviews(events);
    const artifacts = projectArtifacts(events, 'run-rs').artifacts;
    const operator = projectOperator(events, 'run-rs');

    render(
      withSession(
        <ReviewStudio
          runId="run-rs"
          reviewMode="human"
          expectedVersion={38}
          reviews={reviews}
          artifacts={artifacts}
          counts={operator.counts}
          reducedTrust={operator.sandboxFallback}
        />,
      ),
    );

    expect(screen.getByLabelText('trace severity summary')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: /review decision/i })).toBeInTheDocument();
    expect(screen.getByTestId('decision-risk')).toHaveTextContent(/high risk/i);
    expect(screen.getByTestId('confidence-score')).toHaveTextContent('72%');
    expect(screen.getByTestId('reduced-trust')).toBeInTheDocument();
  });
});
