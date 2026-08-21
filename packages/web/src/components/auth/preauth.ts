/**
 * Pre-session CSRF (multi-user U9): the two public POSTs (login, invite
 * redemption) have no session CSRF yet, so browser callers present a
 * DOUBLE-SUBMIT pair — a random value in the `sf_preauth` cookie AND the
 * `x-preauth-csrf` header. Only same-origin JavaScript can set both; the
 * server just compares them (plus the mandatory origin check).
 */

/** Mint the pair: sets the cookie and returns the header value. */
export function armPreauthCsrf(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  const value = btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
  document.cookie = `sf_preauth=${value}; path=/; SameSite=Lax`;
  return value;
}

/** Shared shape for the two public auth POST responses. */
export interface AuthPostFailure {
  readonly error?: string;
  readonly message?: string;
}

/** POST one public auth endpoint with the pre-auth pair attached. */
export async function preauthPost(
  url: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const preauth = armPreauthCsrf();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-preauth-csrf': preauth },
    body: JSON.stringify(body),
  });
  let parsed: Record<string, unknown> = {};
  try {
    parsed = (await res.json()) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  return { ok: res.ok, status: res.status, body: parsed };
}
