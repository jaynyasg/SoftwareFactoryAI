/**
 * Next.js instrumentation hook (runs once at server startup).
 *
 * Eagerly bootstraps the process execution daemon so queued/requeued work
 * RESUMES after a restart without waiting for the first HTTP request. Before
 * this hook, the Next-mounted daemon bootstrapped lazily on the first
 * `getApp()` call (a request), so a hosted instance that restarted with pending
 * queue work sat idle until a request happened to arrive — a divergence from the
 * standalone server, which starts the daemon eagerly. The daemon is a
 * globalThis singleton bootstrapped exactly once, so this is safe to call
 * alongside the lazy `getApp()` path (whichever runs first wins; the other is a
 * no-op).
 *
 * The daemon is Node-only (filesystem event store, child processes), so we skip
 * the edge runtime. `register()` must never throw into startup: any daemon
 * construction/start error is already logged inside `getExecutionDaemon`, and
 * this hook additionally guards the import so a broken bootstrap degrades to the
 * pre-existing lazy behavior instead of crashing the server.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') {
    return;
  }
  try {
    const { getExecutionDaemon } = await import('./server/instance');
    // Constructs + starts the daemon (initial reconcile pass, then the interval
    // loop). Idempotent: a later `getApp()` reuses this same singleton.
    getExecutionDaemon();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[software-factory] instrumentation daemon bootstrap failed: ${message}`);
  }
}
