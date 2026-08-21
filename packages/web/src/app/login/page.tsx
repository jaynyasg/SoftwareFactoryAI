/**
 * Login page (multi-user U9). Single-tenant instances have no login surface —
 * this page bounces straight to the floor. Already-signed-in callers bounce
 * to their return-to. Everyone else gets the form; the return-to travels the
 * whole loop so deep links survive the redirect (G18).
 */
import { redirect } from 'next/navigation';
import { getAuthService, getPageAuth } from '../../server/instance';
import { LoginForm } from '../../components/auth/LoginForm';

export const dynamic = 'force-dynamic';

function safeReturnTo(raw: string | undefined): string {
  // Same-site relative paths only: never an open redirect.
  return raw !== undefined && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string }>;
}) {
  const { returnTo } = await searchParams;
  const target = safeReturnTo(returnTo);
  if (getAuthService() === null) {
    redirect('/');
  }
  const auth = await getPageAuth();
  if (auth !== null) {
    redirect(target);
  }

  return (
    <div className="auth-page">
      <section className="panel auth-panel" aria-label="Sign in to A$APWAIRE">
        <header className="panel__header">
          <h1 className="panel__title">A$APWAIRE</h1>
          <span className="app-header__tag">Sign in</span>
        </header>
        <div className="panel__body">
          <LoginForm returnTo={target} />
          <p className="muted auth-page__hint">
            No account yet? Ask your admin for an invite link.
          </p>
        </div>
      </section>
    </div>
  );
}
