/**
 * Auth-endpoint throttling (U2).
 *
 * The login KDF runs in the SAME single process as the execution daemon, so
 * unthrottled scrypt is a denial-of-service on everyone's runs — and at
 * N=2^17 each in-flight verification costs ~128 MiB, so the concurrency cap
 * is sized by MEMORY (default 1). Counters are in-memory by design: a
 * restart clears lockouts, which is an acceptable v1 trade documented in the
 * plan; the cap and per-key windows are what matter.
 *
 * Client-IP derivation is proxy-aware: behind Render the socket address is
 * proxy-owned, so the client IP is the LAST untrusted-appended entry that the
 * trusted proxy added — i.e. the rightmost value in X-Forwarded-For when a
 * trusted proxy is in front (Render appends the real client last), else the
 * socket address. Attacker-appended entries sit to the LEFT of the
 * proxy-appended one and never win.
 */

export interface ThrottleOptions {
  /** Failures allowed per key inside the window before lockout. */
  readonly maxFailures?: number;
  /** Sliding failure window (ms). */
  readonly windowMs?: number;
  /** Lockout duration once tripped (ms). */
  readonly lockoutMs?: number;
  /** Max concurrent expensive (scrypt) verifications. Memory-sized. */
  readonly maxConcurrentKdf?: number;
  readonly clock?: () => number;
}

export interface AuthThrottle {
  /** True when this key (ip or account) is currently locked out. */
  isLocked(key: string): boolean;
  /** Record a failed attempt for the key. */
  recordFailure(key: string): void;
  /** Clear failures for the key (on success). */
  recordSuccess(key: string): void;
  /** Run an expensive KDF task under the global concurrency cap. */
  withKdfSlot<T>(task: () => Promise<T>): Promise<T>;
}

interface Bucket {
  failures: number[];
  lockedUntil: number;
}

export function createAuthThrottle(options: ThrottleOptions = {}): AuthThrottle {
  const maxFailures = options.maxFailures ?? 8;
  const windowMs = options.windowMs ?? 10 * 60 * 1000;
  const lockoutMs = options.lockoutMs ?? 15 * 60 * 1000;
  const maxConcurrentKdf = options.maxConcurrentKdf ?? 1;
  const clock = options.clock ?? Date.now;

  const buckets = new Map<string, Bucket>();

  function bucketFor(key: string): Bucket {
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = { failures: [], lockedUntil: 0 };
      buckets.set(key, bucket);
    }
    return bucket;
  }

  // Tiny promise-queue semaphore for the KDF cap.
  let active = 0;
  const waiters: (() => void)[] = [];
  function acquire(): Promise<void> {
    if (active < maxConcurrentKdf) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      waiters.push(() => {
        active += 1;
        resolve();
      });
    });
  }
  function release(): void {
    active -= 1;
    const next = waiters.shift();
    if (next !== undefined) {
      next();
    }
  }

  return {
    isLocked(key) {
      const bucket = buckets.get(key);
      return bucket !== undefined && bucket.lockedUntil > clock();
    },
    recordFailure(key) {
      const now = clock();
      const bucket = bucketFor(key);
      bucket.failures = bucket.failures.filter((at) => now - at < windowMs);
      bucket.failures.push(now);
      if (bucket.failures.length >= maxFailures) {
        bucket.lockedUntil = now + lockoutMs;
        bucket.failures = [];
      }
    },
    recordSuccess(key) {
      buckets.delete(key);
    },
    async withKdfSlot(task) {
      await acquire();
      try {
        return await task();
      } finally {
        release();
      }
    },
  };
}

/**
 * Derive the throttle client IP. `trustProxy` reflects deployment reality:
 * true on Render/behind a proxy (read the proxy-appended rightmost XFF
 * entry), false for direct connections (socket address only — XFF is then
 * fully attacker-controlled and ignored).
 */
export function deriveClientIp(
  headers: Readonly<Record<string, string | undefined>>,
  socketAddress: string | undefined,
  trustProxy: boolean,
): string {
  if (trustProxy) {
    const xff = headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.trim().length > 0) {
      const entries = xff.split(',').map((part) => part.trim()).filter((p) => p.length > 0);
      const last = entries[entries.length - 1];
      if (last !== undefined && last.length > 0) {
        return last;
      }
    }
  }
  return socketAddress ?? 'unknown';
}
