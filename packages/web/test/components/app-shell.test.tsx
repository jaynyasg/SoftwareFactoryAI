// @vitest-environment jsdom
/**
 * AppShell + AppShellNav — the shared control-room frame. The view switcher
 * lives HERE (not in FactoryFloor) so every surface gets bidirectional
 * navigation: the trunk-test failure this fixes was /operator rendering with
 * no way back to the floor.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppShell } from '../../src/components/AppShell';

const { pathnameMock } = vi.hoisted(() => ({ pathnameMock: vi.fn<() => string>(() => '/') }));
vi.mock('next/navigation', () => ({ usePathname: pathnameMock }));

describe('AppShell view switcher', () => {
  it('renders both view links with the floor active on /', () => {
    pathnameMock.mockReturnValue('/');
    render(
      <AppShell>
        <p>content</p>
      </AppShell>,
    );

    const floor = screen.getByRole('link', { name: 'Factory floor' });
    const operator = screen.getByRole('link', { name: 'Status view' });
    expect(floor).toHaveAttribute('href', '/');
    expect(operator).toHaveAttribute('href', '/operator');
    expect(floor).toHaveAttribute('aria-current', 'page');
    expect(operator).not.toHaveAttribute('aria-current');
  });

  it('marks the operator link active on /operator and keeps the way back visible', () => {
    pathnameMock.mockReturnValue('/operator');
    render(
      <AppShell>
        <p>content</p>
      </AppShell>,
    );

    expect(screen.getByRole('link', { name: 'Status view' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    // The way BACK: the floor link and the brand home link both point to /.
    expect(screen.getByRole('link', { name: 'Factory floor' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: /A\$APWAIRE/ })).toHaveAttribute('href', '/');
  });
});
