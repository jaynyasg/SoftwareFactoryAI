/**
 * AppShell — the control-room frame (header + main). Server component; the
 * session provider wraps it at the page level.
 */
import type { ReactNode } from 'react';

export function AppShell({ children }: { readonly children: ReactNode }) {
  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header__brand">
          <h1>Software Factory</h1>
          <span className="app-header__tag">Control Room Ledger</span>
        </div>
        <span className="app-header__tag mono">127.0.0.1 · local-first</span>
      </header>
      <main className="app-main">{children}</main>
    </div>
  );
}
