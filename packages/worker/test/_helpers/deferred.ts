/**
 * A minimal externally-resolvable promise. Used to make concurrency tests
 * deterministic: a worker's adapter blocks on a deferred we resolve on command,
 * so we can assert exactly how many workers are in flight before any complete —
 * no timers, no sleeps.
 */
export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Flush pending microtasks so any work that became runnable (without timers) has
 * a chance to start. Deterministic enough for assertions like "no further worker
 * started"; prefer `gatedAdapter.whenStarted(n)` for positive assertions.
 */
export async function flushMicrotasks(times = 5): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}
