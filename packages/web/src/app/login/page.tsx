/**
 * Login page (multi-user U9). Single-tenant instances have no login surface —
 * this page bounces straight to the floor. Already-signed-in callers bounce
 * to their return-to. Everyone else gets the form; the return-to travels the
 * whole loop so deep links survive the redirect (G18).
 */
import { redirect } from 'next/navigation';
import { getAuthService, getPageAuth } from '../../server/instance';
import { LoginForm } from '../../components/auth/LoginForm';
import { sameSiteReturnTo } from '../../lib/safe-return-to';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string }>;
}) {
  const { returnTo } = await searchParams;
  const target = sameSiteReturnTo(returnTo);
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
