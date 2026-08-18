/**
 * AppShell — the control-room frame (header + main). Server component; the
 * session provider wraps it at the page level. The header carries the shared
 * view switcher (AppShellNav) so every surface — floor, operator, and any
 * future page — gets bidirectional navigation, not just the floor.
 */
import type { ReactNode } from 'react';
import Link from 'next/link';
import { AppShellNav } from './AppShellNav';

export function AppShell({ children }: { readonly children: ReactNode }) {
  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header__brand">
          <Link href="/" className="app-header__home">
            <h1>Software Factory</h1>
          </Link>
          <span className="app-header__tag">Control Room Ledger</span>
        </div>
        <AppShellNav />
        <span className="app-header__tag mono">127.0.0.1 · local-first</span>
      </header>
      <main className="app-main">{children}</main>
    </div>
  );
}
