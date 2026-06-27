/**
 * Shared abortable sleep used by the worker's poll loops (preview health gate,
 * render deployer, preview server). Resolves after `ms`, or immediately when the
 * signal is already aborted / aborts mid-wait — it NEVER rejects, so callers can
 * `await` it inside a loop without a try/catch. The timer is cleared on abort so
 * a cancelled wait leaks neither a timer nor a listener.
 */
export function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolvePromise) => {
    if (ms <= 0 || signal?.aborted === true) {
      resolvePromise();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolvePromise();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolvePromise();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
