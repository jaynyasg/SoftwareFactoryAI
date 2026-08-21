/**
 * Invite redemption page (multi-user U9). The invite token rides the URL the
 * admin hands out; the invitee picks a username and password here. Validity
 * is only known at submit time (the server checks atomically), so the page
 * always renders the form — a dead invite resolves to the single designed
 * failure state inside the form (G12).
 */
import { redirect } from 'next/navigation';
import { getAuthService } from '../../../server/instance';
import { InviteRedemptionForm } from '../../../components/auth/InviteRedemptionForm';

export const dynamic = 'force-dynamic';

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  if (getAuthService() === null) {
    redirect('/');
  }

  return (
    <div className="auth-page">
      <section className="panel auth-panel" aria-label="Create your A$APWAIRE account">
        <header className="panel__header">
          <h1 className="panel__title">A$APWAIRE</h1>
          <span className="app-header__tag">You&apos;re invited</span>
        </header>
        <div className="panel__body">
          <p className="muted auth-page__hint">
            Choose a username and password. Your runs execute on YOUR own
            Claude/Codex accounts — you&apos;ll add those credentials right after
            this step.
          </p>
          <InviteRedemptionForm token={token} />
        </div>
      </section>
    </div>
  );
}
