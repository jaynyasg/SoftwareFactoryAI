/**
 * Factory Floor home (server component). The FIRST screen is the run surface:
 * it loads the projected run list, the setup status, and the latest run's
 * aggregate, resolves the page session, and hands them to the client
 * FactoryFloor. All reads go through the same projections the API exposes.
 *
 * Multi-user (U9): the session comes from the request's HttpOnly cookie —
 * anonymous callers redirect to /login with a return-to, and the page payload
 * NEVER contains the operator token. Single-tenant renders exactly as before.
 */
import { redirect } from 'next/navigation';
import { getPageAuth } from '../server/instance';
import {
  loadExecutionOverview,
  loadInterventionQueue,
  loadRunAggregate,
  loadRunList,
  loadSetup,
} from '../server/run-data';
import { SessionProvider } from '../components/session-context';
import { AppShell } from '../components/AppShell';
import { FactoryFloor } from '../components/factory-floor/FactoryFloor';
import type { RunAggregate } from '../lib/types';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const auth = await getPageAuth();
  if (auth === null) {
    redirect('/login?returnTo=%2F');
  }
  const { session, loaderAuth } = auth;
  const [runs, setup, interventions, executionOverview] = await Promise.all([
    loadRunList(loaderAuth),
    loadSetup(loaderAuth),
    loadInterventionQueue(loaderAuth),
    loadExecutionOverview(loaderAuth),
  ]);
  const latestId = runs[0]?.runId ?? null;
  const latest: RunAggregate | null =
    latestId !== null ? await loadRunAggregate(latestId, 0, loaderAuth) : null;

  return (
    <SessionProvider session={session}>
      <AppShell>
        <FactoryFloor
          initialRuns={runs}
          setup={setup}
          latest={latest}
          initialInterventions={interventions}
          initialExecution={executionOverview}
        />
      </AppShell>
    </SessionProvider>
  );
}
