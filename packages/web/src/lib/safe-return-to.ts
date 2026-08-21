/**
 * Shared open-redirect guard for post-login `returnTo` handling (multi-user U9).
 *
 * Both the login page (server component) and the login form (client component)
 * must reduce an untrusted `returnTo` to a SAME-SITE absolute path before it is
 * ever handed to `redirect()` / `window.location.assign()`. They previously
 * each carried their OWN copy of the check, which shared the same flaw and would
 * drift again — this is the single source of truth both import.
 *
 * A positional character check alone is NOT sufficient. The WHATWG URL parser
 * that both `window.location.assign` and the browser's resolution of a server
 * `Location` header run mutates the input BEFORE resolving:
 *   - it rewrites every `\` to `/`, so `/\evil.com` becomes `//evil.com`; and
 *   - it STRIPS ASCII tab (U+0009), LF (U+000A), and CR (U+000D), so a value
 *     like `/` + TAB + `/evil.com` becomes `//evil.com`.
 * Either mutation turns a value that looks same-site under a naive
 * "second char isn't '/' or '\'" test into a scheme-relative URL that navigates
 * off-site. Defend against the parser's own mutations directly:
 *   1. reject any value containing a C0 control char (covers the stripped
 *      tab/LF/CR — a positional guard can't see past a char that is removed);
 *   2. require a single leading '/' whose next char is neither '/' nor '\'
 *      (rejects scheme-relative `//host` and backslash-smuggled `/\host`).
 * A bare `/` is still admitted. A legitimate path never contains raw control
 * characters, so (1) rejects no real return-to.
 */
const SAME_SITE_PATH = /^\/(?![/\\])/;

/** True if `value` contains any C0 control char (0x00–0x1F) or DEL (0x7F). */
function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

export function sameSiteReturnTo(raw: string | undefined): string {
  if (raw === undefined) {
    return '/';
  }
  // 1. The URL parser strips tab/LF/CR before parsing, so a value like
  //    "/<TAB>/evil.com" collapses to "//evil.com" at navigation time. A
  //    positional guard can't see past a stripped char — reject the whole
  //    control-char class up front.
  if (hasControlChar(raw)) {
    return '/';
  }
  // 2. Same-site absolute path: leading '/', next char not '/' or '\'.
  return SAME_SITE_PATH.test(raw) ? raw : '/';
}
