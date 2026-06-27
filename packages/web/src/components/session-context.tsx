'use client';

/**
 * Same-origin session context. A server component reads the operator + CSRF
 * tokens (loopback only) and hands them to this provider; client components read
 * them via `useSession()` to authorize mutating calls. The tokens are present in
 * the initial server-rendered payload and never travel beyond the loopback
 * origin the page was served from.
 */
import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import type { LocalSession } from '../lib/session';

const SessionContext = createContext<LocalSession | null>(null);

export function SessionProvider({
  session,
  children,
}: {
  readonly session: LocalSession;
  readonly children: ReactNode;
}) {
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

export function useSession(): LocalSession {
  const session = useContext(SessionContext);
  if (session === null) {
    throw new Error('useSession must be used within a SessionProvider.');
  }
  return session;
}
