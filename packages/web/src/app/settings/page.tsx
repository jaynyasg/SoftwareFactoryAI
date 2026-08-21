/**
 * Settings (multi-user U10): manage credentials, mint/rotate the personal API
 * token, and sign out (the AppShell user menu carries the logout affordance).
 */
import { redirect } from 'next/navigation';
import { getPageAuth } from '../../server/instance';
import { SessionProvider } from '../../components/session-context';
import { AppShell } from '../../components/AppShell';
import { CredentialWizard } from '../../components/auth/CredentialWizard';
import { ApiTokenPanel } from '../../components/auth/ApiTokenPanel';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const auth = await getPageAuth();
  if (auth === null) {
    redirect('/login?returnTo=%2Fsettings');
  }

  return (
    <SessionProvider session={auth.session}>
      <AppShell>
        <section className="panel" aria-label="Credentials">
          <header className="panel__header">
            <h2 className="panel__title">Credentials</h2>
          </header>
          <div className="panel__body">
            <CredentialWizard />
          </div>
        </section>
        <section className="panel" aria-label="API token">
          <header className="panel__header">
            <h2 className="panel__title">API token</h2>
          </header>
          <div className="panel__body">
            <ApiTokenPanel />
          </div>
        </section>
      </AppShell>
    </SessionProvider>
  );
}
