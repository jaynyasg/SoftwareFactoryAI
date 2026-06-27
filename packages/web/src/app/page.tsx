/**
 * Factory Floor home (server component). The FIRST screen is the run surface:
 * it loads the projected run list, the setup status, and the latest run's
 * aggregate, mints/loads the loopback session, and hands them to the client
 * FactoryFloor. All reads go through the same projections the API exposes.
 */
import { getLocalSession } from '../server/instance';
import { loadRunAggregate, loadRunList, loadSetup } from '../server/run-data';
import { SessionProvider } from '../components/session-context';
import { AppShell } from '../components/AppShell';
import { FactoryFloor } from '../components/factory-floor/FactoryFloor';
import type { RunAggregate } from '../lib/types';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const [session, runs, setup] = await Promise.all([getLocalSession(), loadRunList(), loadSetup()]);
  const latestId = runs[0]?.runId ?? null;
  const latest: RunAggregate | null = latestId !== null ? await loadRunAggregate(latestId) : null;

  return (
    <SessionProvider session={session}>
      <AppShell>
        <FactoryFloor initialRuns={runs} setup={setup} latest={latest} />
      </AppShell>
    </SessionProvider>
  );
}
