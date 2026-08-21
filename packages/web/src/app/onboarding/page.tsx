/**
 * Onboarding wizard (multi-user U10). Where a fresh invite lands: add the
 * credentials runs will execute on. SKIPPABLE by design — a user who exits
 * with no execution credential gets the factory-floor nudge instead of a
 * dead end (a first login never dead-ends).
 */
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getPageAuth } from '../../server/instance';
import { SessionProvider } from '../../components/session-context';
import { AppShell } from '../../components/AppShell';
import { CredentialWizard } from '../../components/auth/CredentialWizard';

export const dynamic = 'force-dynamic';

export default async function OnboardingPage() {
  const auth = await getPageAuth();
  if (auth === null) {
    redirect('/login?returnTo=%2Fonboarding');
  }

  return (
    <SessionProvider session={auth.session}>
      <AppShell>
        <section className="panel" aria-label="Connect your accounts">
          <header className="panel__header">
            <h2 className="panel__title">Connect your accounts</h2>
            <Link href="/" className="button button--ghost">
              Skip for now
            </Link>
          </header>
          <div className="panel__body">
            <p className="muted">
              Runs execute on YOUR accounts — the server has no shared fallback. Add at least one
              execution credential to start runs; everything is encrypted at rest and shown as
              presence only (a saved value can never be read back).
            </p>
            <CredentialWizard />
          </div>
        </section>
      </AppShell>
    </SessionProvider>
  );
}
