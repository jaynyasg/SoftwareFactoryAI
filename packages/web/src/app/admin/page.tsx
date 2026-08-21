/**
 * Admin panel (multi-user U10): invites, users, and revocation. ADMIN ONLY —
 * non-admin accounts bounce to the floor (the API routes enforce the same
 * boundary server-side; this redirect is the polite UI layer on top). The
 * admin's GLOBAL run view is the factory floor itself (admins see every run
 * with owner labels there).
 */
import { redirect } from 'next/navigation';
import { getPageAuth } from '../../server/instance';
import { SessionProvider } from '../../components/session-context';
import { AppShell } from '../../components/AppShell';
import { AdminInvites } from '../../components/auth/AdminInvites';
import { AdminUsers } from '../../components/auth/AdminUsers';

export const dynamic = 'force-dynamic';

export default async function AdminPage() {
  const auth = await getPageAuth();
  if (auth === null) {
    redirect('/login?returnTo=%2Fadmin');
  }
  if (auth.session.identity?.role !== 'admin') {
    redirect('/');
  }

  return (
    <SessionProvider session={auth.session}>
      <AppShell>
        <section className="panel" aria-label="Invites">
          <header className="panel__header">
            <h2 className="panel__title">Invites</h2>
          </header>
          <div className="panel__body">
            <AdminInvites />
          </div>
        </section>
        <section className="panel" aria-label="Users">
          <header className="panel__header">
            <h2 className="panel__title">Users</h2>
          </header>
          <div className="panel__body">
            <AdminUsers />
          </div>
        </section>
      </AppShell>
    </SessionProvider>
  );
}
