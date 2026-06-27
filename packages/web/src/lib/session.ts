/**
 * The loopback session tokens shared between the server (which mints them) and
 * the client (which echoes them on mutating calls). Type-only, so it is safe to
 * import from both the Node server modules and the browser bundle.
 */
export interface LocalSession {
  readonly operatorToken: string;
  readonly csrfToken: string;
}
