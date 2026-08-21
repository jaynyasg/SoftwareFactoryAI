/**
 * Run detail (server component). Loads the projected run aggregate for the
 * route id and the page session, then renders the client RunDetail surface.
 *
 * Multi-user (U9): anonymous callers redirect to /login carrying THIS run's
 * path as the return-to, so a shared deep link lands back on the run after
 * sign-in. Owner scoping applies through the loaders (a foreign run 404s).
 */
import { notFound, redirect } from 'next/navigation';
import { getPageAuth } from '../../../server/instance';
import { loadExecutionOverview, loadRunAggregate } from '../../../server/run-data';
import { SessionProvider } from '../../../components/session-context';
import { AppShell } from '../../../components/AppShell';
import { RunDetail } from '../../../components/factory-floor/RunDetail';

export const dynamic = 'force-dynamic';

export default async function RunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const auth = await getPageAuth();
  if (auth === null) {
    redirect(`/login?returnTo=${encodeURIComponent(`/runs/${runId}`)}`);
  }
  const { session, loaderAuth } = auth;
  const [initial, executionOverview] = await Promise.all([
    loadRunAggregate(runId, 0, loaderAuth),
    loadExecutionOverview(loaderAuth),
  ]);
  if (initial === null) {
    notFound();
  }

  return (
    <SessionProvider session={session}>
      <AppShell>
        <RunDetail runId={runId} initial={initial} initialExecution={executionOverview} />
      </AppShell>
    </SessionProvider>
  );
}
