/**
 * The page session shared between the server (which resolves it) and the
 * client (which echoes tokens on mutating calls). Type-only, so it is safe to
 * import from both the Node server modules and the browser bundle.
 *
 * Two shapes, one type (multi-user U9):
 *  - SINGLE-TENANT: `{ operatorToken, csrfToken }` — the loopback operator
 *    token rides mutation headers exactly as before.
 *  - MULTI-USER: `{ csrfToken, identity, multiUser: true }` — the page NEVER
 *    carries the operator token; the session COOKIE (HttpOnly, sent
 *    automatically on same-origin fetches) authenticates, and the per-session
 *    CSRF token guards mutations.
 */

/** The signed-in account (multi-user mode). */
export interface SessionIdentity {
  readonly userId: string;
  readonly username: string;
  readonly role: 'admin' | 'user';
}

export interface LocalSession {
  /**
   * Loopback operator token — SINGLE-TENANT ONLY. Never present in
   * multi-user mode (the session cookie authenticates instead).
   */
  readonly operatorToken?: string;
  /** Double-submit CSRF token (process-wide single-tenant; per-session multi-user). */
  readonly csrfToken: string;
  /** The signed-in account. Present only in multi-user mode. */
  readonly identity?: SessionIdentity;
  /** True when this factory runs multi-user auth (drives logout affordances). */
  readonly multiUser?: boolean;
}
