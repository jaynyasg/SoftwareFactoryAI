/**
 * Composable, AbortController-based cancellation.
 *
 * The scheduler creates a RUN-level token; each worker gets a CHILD token. A
 * child is cancelled when (a) it is cancelled directly (cancel one worker) or
 * (b) its parent is cancelled (cancel the whole run). The child's `signal` is
 * what the worker runner hands to `adapter.execute`, so a run-level cancel
 * propagates all the way down to every in-flight adapter.
 *
 * Each scope exposes a human-facing `reason`, an `onCancel` subscription, and a
 * `dispose` that detaches the parent link so cancellation never leaks listeners.
 */

/** A cancellation scope wrapping an `AbortController` with composition. */
export interface CancellationScope {
  /** The signal handed to downstream work (e.g. `adapter.execute`). */
  readonly signal: AbortSignal;
  /** Whether this scope has been cancelled. */
  readonly aborted: boolean;
  /** The reason captured at cancellation, when one was supplied. */
  readonly reason: string | undefined;
  /** Cancel this scope (and, transitively, its children). Idempotent. */
  cancel(reason?: string): void;
  /** Create a child scope cancelled when this scope (or the child) is. */
  child(reason?: string): CancellationScope;
  /** Subscribe to cancellation; returns an unsubscribe function. */
  onCancel(listener: (reason: string | undefined) => void): () => void;
  /** Detach from the parent and drop listeners. Does not cancel. */
  dispose(): void;
}

const DEFAULT_REASON = 'cancelled';

/**
 * Create a cancellation scope. When `parent` is provided (a signal or another
 * scope), this scope is cancelled whenever the parent aborts (composition).
 */
export function createCancellation(
  parent?: AbortSignal | CancellationScope,
  reason?: string,
): CancellationScope {
  const controller = new AbortController();
  const listeners = new Set<(reason: string | undefined) => void>();
  let cancelReason: string | undefined = reason;
  let disposed = false;

  const parentSignal =
    parent === undefined ? undefined : 'signal' in parent ? parent.signal : parent;

  const fire = (): void => {
    for (const listener of [...listeners]) {
      listener(cancelReason);
    }
    listeners.clear();
  };

  const doCancel = (nextReason?: string): void => {
    if (controller.signal.aborted) {
      return;
    }
    if (nextReason !== undefined) {
      cancelReason = nextReason;
    } else if (cancelReason === undefined) {
      cancelReason = DEFAULT_REASON;
    }
    controller.abort(cancelReason);
    fire();
  };

  const onParentAbort = (): void => {
    const parentReason =
      parentSignal !== undefined && typeof parentSignal.reason === 'string'
        ? parentSignal.reason
        : cancelReason;
    doCancel(parentReason);
  };

  if (parentSignal !== undefined) {
    if (parentSignal.aborted) {
      // Defer to the next microtask so callers can wire `onCancel` first.
      queueMicrotask(onParentAbort);
    } else {
      parentSignal.addEventListener('abort', onParentAbort, { once: true });
    }
  }

  const detachParent = (): void => {
    if (parentSignal !== undefined) {
      parentSignal.removeEventListener('abort', onParentAbort);
    }
  };

  const scope: CancellationScope = {
    get signal(): AbortSignal {
      return controller.signal;
    },
    get aborted(): boolean {
      return controller.signal.aborted;
    },
    get reason(): string | undefined {
      return controller.signal.aborted ? cancelReason : undefined;
    },
    cancel(nextReason?: string): void {
      doCancel(nextReason);
    },
    child(childReason?: string): CancellationScope {
      return createCancellation(scope, childReason);
    },
    onCancel(listener): () => void {
      if (controller.signal.aborted) {
        listener(cancelReason);
        return () => {};
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      detachParent();
      listeners.clear();
    },
  };

  return scope;
}

/** Extract an `AbortSignal` from a signal/scope (or `undefined`). */
export function toSignal(source?: AbortSignal | CancellationScope): AbortSignal | undefined {
  if (source === undefined) {
    return undefined;
  }
  return 'signal' in source ? source.signal : source;
}
