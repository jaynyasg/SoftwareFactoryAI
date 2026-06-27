/**
 * Normalized execution-adapter failures.
 *
 * Every adapter (local CLI, hosted API, or a fake in tests) funnels its raw
 * spawn/exec/transport failures through `normalizeAdapterError` so the worker
 * runner and scheduler only ever see ONE closed set of failure kinds. The kinds
 * are split into a retryable class (transient — a bounded retry may succeed) and
 * a terminal class (a retry cannot help; surface to the operator or stop).
 *
 * `AdapterError` is a class (so it can be thrown / `instanceof`-checked) whose
 * `kind` field is the discriminant — `switch (error.kind)` narrows exhaustively.
 */

/** The closed set of normalized adapter failure kinds. */
export type AdapterErrorKind =
  | 'unavailable'
  | 'unauthenticated'
  | 'rate_limited'
  | 'usage_limited'
  | 'tool_denied'
  | 'timeout'
  | 'cancelled'
  | 'malformed_output';

/** Kinds a bounded retry may recover from. */
export const RETRYABLE_ADAPTER_ERROR_KINDS: readonly AdapterErrorKind[] = [
  'rate_limited',
  'timeout',
  'malformed_output',
];

/** Kinds that a retry cannot fix (setup, policy, quota, or intentional stop). */
export const TERMINAL_ADAPTER_ERROR_KINDS: readonly AdapterErrorKind[] = [
  'unavailable',
  'unauthenticated',
  'usage_limited',
  'tool_denied',
  'cancelled',
];

const RETRYABLE = new Set<AdapterErrorKind>(RETRYABLE_ADAPTER_ERROR_KINDS);

/** Optional structured detail attached to a normalized error. */
export interface AdapterErrorOptions {
  /** The underlying raw error/value, preserved for diagnostics. */
  readonly cause?: unknown;
  /** Extra human-facing detail (e.g. a trimmed stderr tail). */
  readonly detail?: string;
  /** Suggested backoff before a retry, when the source advertised one. */
  readonly retryAfterMs?: number;
  /** The exit code, when the failure came from a process. */
  readonly exitCode?: number;
}

/**
 * A normalized adapter failure. Construct via the static helpers (or
 * `normalizeAdapterError`) rather than `new` so the message stays consistent.
 */
export class AdapterError extends Error {
  readonly kind: AdapterErrorKind;
  readonly detail?: string;
  readonly retryAfterMs?: number;
  readonly exitCode?: number;

  constructor(kind: AdapterErrorKind, message: string, options: AdapterErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AdapterError';
    this.kind = kind;
    this.detail = options.detail;
    this.retryAfterMs = options.retryAfterMs;
    this.exitCode = options.exitCode;
  }

  /** `true` when a bounded retry may succeed. */
  get retryable(): boolean {
    return RETRYABLE.has(this.kind);
  }

  static unavailable(message: string, options?: AdapterErrorOptions): AdapterError {
    return new AdapterError('unavailable', message, options);
  }
  static unauthenticated(message: string, options?: AdapterErrorOptions): AdapterError {
    return new AdapterError('unauthenticated', message, options);
  }
  static rateLimited(message: string, options?: AdapterErrorOptions): AdapterError {
    return new AdapterError('rate_limited', message, options);
  }
  static usageLimited(message: string, options?: AdapterErrorOptions): AdapterError {
    return new AdapterError('usage_limited', message, options);
  }
  static toolDenied(message: string, options?: AdapterErrorOptions): AdapterError {
    return new AdapterError('tool_denied', message, options);
  }
  static timeout(message: string, options?: AdapterErrorOptions): AdapterError {
    return new AdapterError('timeout', message, options);
  }
  static cancelled(
    message = 'Adapter execution was cancelled.',
    options?: AdapterErrorOptions,
  ): AdapterError {
    return new AdapterError('cancelled', message, options);
  }
  static malformedOutput(message: string, options?: AdapterErrorOptions): AdapterError {
    return new AdapterError('malformed_output', message, options);
  }
}

/** Type guard for a normalized `AdapterError`. */
export function isAdapterError(value: unknown): value is AdapterError {
  return value instanceof AdapterError;
}

/** Whether a bounded retry may recover from this error/kind. */
export function isRetryableAdapterError(error: AdapterError | AdapterErrorKind): boolean {
  const kind = typeof error === 'string' ? error : error.kind;
  return RETRYABLE.has(kind);
}

/** Whether this error/kind is terminal (a retry cannot help). */
export function isTerminalAdapterError(error: AdapterError | AdapterErrorKind): boolean {
  return !isRetryableAdapterError(error);
}

/** Whether this error represents an intentional cancellation (not a fault). */
export function isCancellation(error: AdapterError | AdapterErrorKind): boolean {
  const kind = typeof error === 'string' ? error : error.kind;
  return kind === 'cancelled';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Detect an `AbortError` / aborted-signal shaped value. */
function isAbortLike(value: unknown): boolean {
  if (isRecord(value) && value.name === 'AbortError') {
    return true;
  }
  return value instanceof Error && value.name === 'AbortError';
}

/** Pull a `code` (e.g. ENOENT) off a Node `ErrnoException`-shaped value. */
function errnoCode(value: unknown): string | undefined {
  if (isRecord(value) && typeof value.code === 'string') {
    return value.code;
  }
  return undefined;
}

function messageOf(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (isRecord(value) && typeof value.message === 'string') {
    return value.message;
  }
  return String(value);
}

/** Ordered (pattern -> kind) table for text-based classification. */
const TEXT_RULES: readonly { readonly pattern: RegExp; readonly kind: AdapterErrorKind }[] = [
  { pattern: /\b(rate[\s-]?limit|too many requests|429)\b/i, kind: 'rate_limited' },
  {
    pattern: /\b(usage limit|quota|insufficient_quota|out of credits?|billing)\b/i,
    kind: 'usage_limited',
  },
  {
    pattern:
      /\b(unauthenticated|unauthorized|not logged in|please (?:re-?)?login|authenticat|invalid api key|401|403)\b/i,
    kind: 'unauthenticated',
  },
  { pattern: /\b(timed? ?out|timeout|etimedout|deadline exceeded)\b/i, kind: 'timeout' },
  {
    pattern:
      /\b(permission denied|not allowed|tool.*(denied|blocked)|denied|forbidden|eacces|eperm)\b/i,
    kind: 'tool_denied',
  },
  {
    pattern:
      /\b(malformed|unparse?able|invalid json|failed to parse|unexpected token|parse error)\b/i,
    kind: 'malformed_output',
  },
];

/**
 * Map any raw spawn/exec/transport failure to a normalized `AdapterError`.
 *
 * Resolution order: an already-normalized error passes through; an aborted
 * signal becomes `cancelled`; a missing executable (`ENOENT`) becomes
 * `unavailable`; otherwise the message is matched against the text rules; an
 * unrecognized failure falls back to `unavailable` (terminal — we refuse to
 * silently hammer an adapter we cannot classify).
 */
export function normalizeAdapterError(
  raw: unknown,
  options: AdapterErrorOptions = {},
): AdapterError {
  if (raw instanceof AdapterError) {
    return raw;
  }

  const message = messageOf(raw);
  const merged: AdapterErrorOptions = { cause: raw, ...options };

  if (isAbortLike(raw)) {
    return AdapterError.cancelled('Adapter execution was cancelled.', merged);
  }

  const code = errnoCode(raw);
  if (code === 'ENOENT') {
    return AdapterError.unavailable(`Executable not found (${message || 'ENOENT'}).`, {
      ...merged,
      detail: merged.detail ?? code,
    });
  }
  if (code === 'ETIMEDOUT') {
    return AdapterError.timeout(`Execution timed out (${message || code}).`, merged);
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return AdapterError.toolDenied(`Permission denied (${message || code}).`, merged);
  }

  for (const rule of TEXT_RULES) {
    if (rule.pattern.test(message)) {
      return new AdapterError(rule.kind, message, merged);
    }
  }

  return AdapterError.unavailable(
    message.length > 0 ? message : 'Adapter failed with an unrecognized error.',
    merged,
  );
}
