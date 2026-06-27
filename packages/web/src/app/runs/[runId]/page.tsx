/**
 * Run detail (server component). Loads the projected run aggregate for the route
 * id and the loopback session, then renders the client RunDetail surface.
 */
import { notFound } from 'next/navigation';
import { getLocalSession } from '../../../server/instance';
import { loadRunAggregate } from '../../../server/run-data';
import { SessionProvider } from '../../../components/session-context';
import { AppShell } from '../../../components/AppShell';
import { RunDetail } from '../../../components/factory-floor/RunDetail';

export const dynamic = 'force-dynamic';

export default async function RunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const [session, initial] = await Promise.all([getLocalSession(), loadRunAggregate(runId)]);
  if (initial === null) {
    notFound();
  }

  return (
    <SessionProvider session={session}>
      <AppShell>
        <RunDetail runId={runId} initial={initial} />
      </AppShell>
    </SessionProvider>
  );
}
