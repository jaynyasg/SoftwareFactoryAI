/**
 * U3 — identity resolution, auth routes, and declared route access.
 *
 * Pins the multi-user contract at the route layer:
 *  - login/redeem set the default-secure `__Host-` session cookie (plain
 *    `sf_session` only on the explicit insecure opt-out);
 *  - pre-session CSRF (origin check + double-submit pair) guards the two
 *    public POSTs; per-session CSRF guards session mutations after;
 *  - bearer/header-token callers are CSRF-exempt in every mode;
 *  - strict-precedence validate-or-reject: an invalid presented credential
 *    never falls through to a weaker one;
 *  - the legacy shared operator token is refused with migration guidance;
 *  - admin routes 403 for members; revocation is live (no cached auth);
 *  - the liveness endpoint is byte-identical across auth modes;
 *  - unclassified routes cannot register (default-deny pin);
 *  - the standalone HTTP transport behaves identically to direct handle().
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createInMemoryEventStore,
  createInMemoryOperatorTokenStore,
  createOperatorTokenProvider,
  type EventStore,
} from '@software-factory/core';
import {
  assertRoutesClassified,
  createApp,
  type ApiRequest,
  type ApiResponse,
  type App,
  type RouteDef,
} from '../../src/server/app';
import {
  createAuthService,
  createInMemoryAuthStores,
  type AuthService,
} from '../../src/server/auth/service';
import { createAuthThrottle, type AuthThrottle } from '../../src/server/auth/throttle';
import type { Identity } from '../../src/server/auth/records';

const ORIGIN = 'http://127.0.0.1:5173';
const LEGACY_TOKEN = 'legacy-operator-token';
const BOOTSTRAP = 'bootstrap-invite-0123456789abcdef';
const PASSWORD = 'correct-horse-battery';

function deterministic() {
  let id = 0;
  let now = 1_700_000_000_000;
  return {
    idGenerator: () => `evt-${(id += 1)}`,
    clock: () => (now += 1000),
  };
}

interface TestBundle {
  readonly app: App;
  readonly service: AuthService;
  readonly store: EventStore;
}

function makeMultiUserApp(
  opts: { insecureCookies?: boolean; throttle?: AuthThrottle; trustProxy?: boolean } = {},
): TestBundle {
  const store = createInMemoryEventStore(deterministic());
  const provider = createOperatorTokenProvider({
    store: createInMemoryOperatorTokenStore({ token: LEGACY_TOKEN, createdAt: 0 }),
  });
  const service = createAuthService({
    stores: createInMemoryAuthStores(),
    bootstrapInvite: BOOTSTRAP,
    throttle: opts.throttle,
  });
  let runSeq = 0;
  const app = createApp({
    store,
    operatorToken: provider,
    idGenerator: () => `run-${(runSeq += 1)}`,
    config: { allowedOrigins: [ORIGIN], trustProxy: opts.trustProxy },
    planner: null,
    auth: { service, insecureCookies: opts.insecureCookies },
  });
  return { app, service, store };
}

function makeSingleTenantApp(): TestBundle {
  const store = createInMemoryEventStore(deterministic());
  const provider = createOperatorTokenProvider({
    store: createInMemoryOperatorTokenStore({ token: LEGACY_TOKEN, createdAt: 0 }),
  });
  // Single-tenant twin: same composition, no auth deps at all.
  const service = createAuthService({ stores: createInMemoryAuthStores() });
  let runSeq = 0;
  const app = createApp({
    store,
    operatorToken: provider,
    idGenerator: () => `run-${(runSeq += 1)}`,
    config: { allowedOrigins: [ORIGIN] },
    planner: null,
  });
  return { app, service, store };
}

function req(
  method: string,
  path: string,
  headers: Record<string, string | undefined> = {},
  body?: unknown,
  socketAddress?: string,
): ApiRequest {
  return { method, path, query: {}, headers, body, socketAddress };
}

function errorOf(res: ApiResponse): unknown {
  return (res.body as { error?: unknown }).error;
}

interface ParsedCookie {
  readonly name: string;
  readonly value: string;
  readonly raw: string;
}

function cookieOf(res: ApiResponse): ParsedCookie {
  const raw = res.headers?.['set-cookie'];
  expect(raw, 'expected a Set-Cookie header').toBeDefined();
  const pair = (raw as string).split(';')[0];
  const eq = pair.indexOf('=');
  return {
    name: pair.slice(0, eq),
    value: decodeURIComponent(pair.slice(eq + 1)),
    raw: raw as string,
  };
}

interface SessionFixture {
  /** `name=value` ready for a Cookie header. */
  readonly cookie: string;
  readonly csrf: string;
  readonly identity: Identity;
}

/** Redeem an invite through the ROUTE (non-browser caller: no Origin header). */
async function redeemViaRoute(app: App, token: string, username: string): Promise<SessionFixture> {
  const res = await app.handle(
    req('POST', '/api/auth/invite/redeem', {}, { token, username, password: PASSWORD }),
  );
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const cookie = cookieOf(res);
  const body = res.body as { identity: Identity; csrfToken: string };
  return { cookie: `${cookie.name}=${cookie.value}`, csrf: body.csrfToken, identity: body.identity };
}

describe('multi-user auth routes (U3)', () => {
  let bundle: TestBundle;
  let admin: SessionFixture;

  beforeAll(async () => {
    bundle = makeMultiUserApp();
    admin = await redeemViaRoute(bundle.app, BOOTSTRAP, 'the-admin');
  });

  it('bootstrap redemption mints the admin with a default-secure __Host- cookie', async () => {
    // Fresh app so this test owns its bootstrap.
    const own = makeMultiUserApp();
    const res = await own.app.handle(
      req('POST', '/api/auth/invite/redeem', {}, {
        token: BOOTSTRAP,
        username: 'first-admin',
        password: PASSWORD,
      }),
    );
    expect(res.status).toBe(201);
    const cookie = cookieOf(res);
    expect(cookie.name).toBe('__Host-sf_session');
    expect(cookie.raw).toContain('HttpOnly');
    expect(cookie.raw).toContain('Secure');
    expect(cookie.raw).toContain('SameSite=Lax');
    expect((res.body as { identity: Identity }).identity.role).toBe('admin');

    const who = await own.app.handle(
      req('GET', '/api/auth/identity', { cookie: `${cookie.name}=${cookie.value}` }),
    );
    expect(who.status).toBe(200);
    expect((who.body as { identity: Identity }).identity.role).toBe('admin');
  });

  it('SF_INSECURE_COOKIES form: plain sf_session without Secure (never a broken __Host- combo)', async () => {
    const own = makeMultiUserApp({ insecureCookies: true });
    const res = await own.app.handle(
      req('POST', '/api/auth/invite/redeem', {}, {
        token: BOOTSTRAP,
        username: 'lan-admin',
        password: PASSWORD,
      }),
    );
    expect(res.status).toBe(201);
    const cookie = cookieOf(res);
    expect(cookie.name).toBe('sf_session');
    expect(cookie.raw).toContain('HttpOnly');
    expect(cookie.raw).not.toContain('Secure');
    expect(cookie.raw).not.toContain('__Host-');
  });

  it('login → identity → logout lifecycle; the deleted session stops working immediately', async () => {
    const login = await bundle.app.handle(
      req('POST', '/api/auth/login', {}, { username: 'the-admin', password: PASSWORD }),
    );
    expect(login.status, JSON.stringify(login.body)).toBe(200);
    const cookie = cookieOf(login);
    const csrf = (login.body as { csrfToken: string }).csrfToken;
    const cookieHeader = `${cookie.name}=${cookie.value}`;

    const who = await bundle.app.handle(req('GET', '/api/auth/identity', { cookie: cookieHeader }));
    expect(who.status).toBe(200);
    expect((who.body as { identity: Identity }).identity.username).toBe('the-admin');

    const out = await bundle.app.handle(
      req('POST', '/api/auth/logout', {
        cookie: cookieHeader,
        origin: ORIGIN,
        'x-csrf-token': csrf,
      }),
    );
    expect(out.status).toBe(200);
    expect(cookieOf(out).raw).toContain('Max-Age=0');

    const after = await bundle.app.handle(
      req('GET', '/api/auth/identity', { cookie: cookieHeader }),
    );
    expect(after.status).toBe(401);
  });

  it('pre-session CSRF: browser callers need the allowed origin + double-submit pair on login AND redeem', async () => {
    for (const [path, body] of [
      ['/api/auth/login', { username: 'the-admin', password: PASSWORD }],
      ['/api/auth/invite/redeem', { token: 'whatever', username: 'x', password: PASSWORD }],
    ] as const) {
      // Origin present but no pair → csrf_failed before any credential work.
      const bare = await bundle.app.handle(req('POST', path, { origin: ORIGIN }, body));
      expect(bare.status, path).toBe(403);
      expect(errorOf(bare), path).toBe('csrf_failed');

      // Disallowed origin → rejected outright.
      const evil = await bundle.app.handle(
        req('POST', path, { origin: 'https://evil.example' }, body),
      );
      expect(evil.status, path).toBe(403);
      expect(errorOf(evil), path).toBe('origin_not_allowed');
    }

    // Allowed origin + matching pair → passes the pre-auth gate (login succeeds).
    const ok = await bundle.app.handle(
      req(
        'POST',
        '/api/auth/login',
        { origin: ORIGIN, cookie: 'sf_preauth=pre-123', 'x-preauth-csrf': 'pre-123' },
        { username: 'the-admin', password: PASSWORD },
      ),
    );
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it('anonymous caller on an authenticated route → 401 with a returnTo affordance (G18)', async () => {
    const res = await bundle.app.handle(req('GET', '/api/runs'));
    expect(res.status).toBe(401);
    expect(errorOf(res)).toBe('unauthenticated');
    expect((res.body as { returnTo?: string }).returnTo).toBe('/api/runs');
  });

  it('liveness endpoint is byte-identical across auth modes; /api/setup 401s anonymously', async () => {
    const single = makeSingleTenantApp();
    const armed = makeMultiUserApp();
    const consumed = bundle; // bootstrap already redeemed in beforeAll

    const bodies: string[] = [];
    for (const { app } of [single, armed, consumed]) {
      const res = await app.handle(req('GET', '/api/healthz'));
      expect(res.status).toBe(200);
      bodies.push(JSON.stringify(res.body));
    }
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0])).toEqual({ status: 'ok' });

    const setup = await bundle.app.handle(req('GET', '/api/setup'));
    expect(setup.status).toBe(401);
  });

  it('strict precedence: an invalid session cookie NEVER falls through to a valid bearer', async () => {
    const minted = await bundle.service.mintApiToken(admin.identity.userId);
    expect(minted).not.toBeNull();
    const res = await bundle.app.handle(
      req('GET', '/api/runs', {
        cookie: '__Host-sf_session=forged-session-value',
        authorization: `Bearer ${minted?.token ?? ''}`,
      }),
    );
    expect(res.status).toBe(401);
    expect(errorOf(res)).toBe('unauthenticated');
  });

  it('a malformed session cookie (bad %-escape) fails as 401, never 500s the route', async () => {
    // decodeURIComponent throws URIError on a lone/invalid percent-escape.
    // resolveIdentity reads the cookie for EVERY request, so an undecodable
    // value must degrade to a clean auth failure — not a 500 that locks the
    // browser out of login/logout until cookies are cleared by hand.
    const res = await bundle.app.handle(
      req('GET', '/api/runs', { cookie: '__Host-sf_session=%E0%A4%A' }),
    );
    expect(res.status).toBe(401);
    expect(errorOf(res)).toBe('unauthenticated');
  });

  it('legacy shared operator token → 401 with migration guidance; single-tenant twin unchanged', async () => {
    const res = await bundle.app.handle(
      req('GET', '/api/runs', { 'x-operator-token': LEGACY_TOKEN }),
    );
    expect(res.status).toBe(401);
    expect(errorOf(res)).toBe('multi_user_enabled');
    expect((res.body as { message: string }).message).toContain('personal API token');

    const single = makeSingleTenantApp();
    const ok = await single.app.handle(
      req('GET', '/api/runs', { 'x-operator-token': LEGACY_TOKEN }),
    );
    expect(ok.status).toBe(200);
  });

  it('admin routes: member → 403; admin succeeds (factory-wide cancel-all)', async () => {
    const invite = await bundle.service.issueInvite(admin.identity.userId);
    const member = await redeemViaRoute(bundle.app, invite.token, 'member-one');
    expect(member.identity.role).toBe('user');

    for (const path of [
      '/api/execution/hold',
      '/api/execution/resume',
      '/api/runs/cancel-all',
      '/api/runs/clear-all',
    ]) {
      const res = await bundle.app.handle(
        req('POST', path, { cookie: member.cookie, origin: ORIGIN, 'x-csrf-token': member.csrf }),
      );
      expect(res.status, path).toBe(403);
      expect(errorOf(res), path).toBe('forbidden');
    }

    const ok = await bundle.app.handle(
      req('POST', '/api/runs/cancel-all', {
        cookie: admin.cookie,
        origin: ORIGIN,
        'x-csrf-token': admin.csrf,
      }),
    );
    expect(ok.status).toBe(200);
  });

  it('revocation is live: an sfai_ bearer dies the moment its user is revoked (no cached auth)', async () => {
    const invite = await bundle.service.issueInvite(admin.identity.userId);
    const member = await redeemViaRoute(bundle.app, invite.token, 'member-doomed');
    const minted = await bundle.service.mintApiToken(member.identity.userId);
    expect(minted).not.toBeNull();

    const before = await bundle.app.handle(
      req('GET', '/api/runs', { authorization: `Bearer ${minted?.token ?? ''}` }),
    );
    expect(before.status).toBe(200);

    const outcome = await bundle.service.revokeUser(member.identity.userId);
    expect(outcome.ok).toBe(true);

    const after = await bundle.app.handle(
      req('GET', '/api/runs', { authorization: `Bearer ${minted?.token ?? ''}` }),
    );
    expect(after.status).toBe(401);
  });

  it('session mutations require the PER-SESSION CSRF; bearer mutations are exempt', async () => {
    const wrong = await bundle.app.handle(
      req(
        'POST',
        '/api/runs',
        { cookie: admin.cookie, origin: ORIGIN, 'x-csrf-token': 'not-the-session-csrf' },
        { prompt: 'x' },
      ),
    );
    expect(wrong.status).toBe(403);
    expect(errorOf(wrong)).toBe('csrf_failed');

    const right = await bundle.app.handle(
      req(
        'POST',
        '/api/runs',
        { cookie: admin.cookie, origin: ORIGIN, 'x-csrf-token': admin.csrf },
        { prompt: 'x' },
      ),
    );
    expect(right.status, JSON.stringify(right.body)).toBe(201);

    // Bearer caller: NO CSRF header at all, in multi-user mode → still allowed.
    const minted = await bundle.service.mintApiToken(admin.identity.userId);
    const bearer = await bundle.app.handle(
      req('POST', '/api/runs', { 'x-operator-token': minted?.token ?? '' }, { prompt: 'y' }),
    );
    expect(bearer.status, JSON.stringify(bearer.body)).toBe(201);
  });

  it('repeated failed logins trip the throttle → 429 locked_out', async () => {
    const own = makeMultiUserApp({
      throttle: createAuthThrottle({ maxFailures: 2, maxConcurrentKdf: 1 }),
    });
    await redeemViaRoute(own.app, BOOTSTRAP, 'locked-admin');
    const attempt = () =>
      own.app.handle(
        req('POST', '/api/auth/login', {}, { username: 'locked-admin', password: 'wrong-password' }),
      );
    expect((await attempt()).status).toBe(401);
    expect((await attempt()).status).toBe(401);
    const locked = await attempt();
    expect(locked.status).toBe(429);
    expect(errorOf(locked)).toBe('locked_out');
  });

  // The login throttle keys on BOTH a per-username bucket and a per-IP bucket
  // (service.ts). #7 is entirely about the per-IP key, so these tests vary the
  // username on every attempt — that keeps the username bucket from tripping
  // and isolates the IP-key behavior that `trustProxy` governs.
  it('#7: with trustProxy OFF, a rotating X-Forwarded-For CANNOT evade the per-IP login throttle', async () => {
    // Default (direct/LAN) deployment: XFF is fully attacker-controlled and
    // must be ignored. An attacker rotating fake IPs (and usernames) hopes each
    // gets its own IP bucket; with the socket address as the real key they all
    // collapse to ONE bucket, so the lockout still fires on the 3rd attempt.
    const own = makeMultiUserApp({
      throttle: createAuthThrottle({ maxFailures: 2, maxConcurrentKdf: 1 }),
    });
    const spoof = (fakeIp: string, user: string) =>
      own.app.handle(
        req(
          'POST',
          '/api/auth/login',
          { 'x-forwarded-for': fakeIp },
          { username: user, password: 'wrong-password' },
          '203.0.113.9', // the real socket — identical across every attempt
        ),
      );
    expect((await spoof('1.1.1.1', 'ghost-a')).status).toBe(401);
    expect((await spoof('2.2.2.2', 'ghost-b')).status).toBe(401);
    // Third distinct fake IP + username — only the socket key is shared, and it
    // has tripped: XFF rotation bought the attacker nothing.
    const locked = await spoof('3.3.3.3', 'ghost-c');
    expect(locked.status).toBe(429);
    expect(errorOf(locked)).toBe('locked_out');
  });

  it('#7: with trustProxy ON, distinct X-Forwarded-For values get distinct per-IP buckets', async () => {
    // Behind a trusted proxy that overwrites XFF (Render/cloud), the rightmost
    // XFF entry IS the real client and must key the throttle — otherwise every
    // proxied user shares the one proxy-socket bucket and a single attacker
    // locks out everyone.
    const own = makeMultiUserApp({
      throttle: createAuthThrottle({ maxFailures: 2, maxConcurrentKdf: 1 }),
      trustProxy: true,
    });
    const fromIp = (ip: string, user: string) =>
      own.app.handle(
        req(
          'POST',
          '/api/auth/login',
          { 'x-forwarded-for': ip },
          { username: user, password: 'wrong-password' },
          '10.0.0.1', // shared proxy socket — must NOT be the key when trusted
        ),
      );
    // Fill client .1's IP bucket to the limit (distinct usernames throughout).
    expect((await fromIp('198.51.100.1', 'ghost-1')).status).toBe(401);
    expect((await fromIp('198.51.100.1', 'ghost-2')).status).toBe(401);
    // A different client IP is untouched — its own fresh bucket, NOT locked out.
    expect((await fromIp('198.51.100.2', 'ghost-3')).status).toBe(401);
    // Client .1 is now over the limit: its IP bucket accumulated independently.
    const locked = await fromIp('198.51.100.1', 'ghost-4');
    expect(locked.status).toBe(429);
    expect(errorOf(locked)).toBe('locked_out');
  });

  it('default-deny pin: a route without a valid access class cannot register', () => {
    const smuggled = {
      method: 'POST',
      pattern: '/api/unguarded',
      handler: () => Promise.resolve({ status: 200, body: {} }),
    } as unknown as RouteDef;
    expect(() => assertRoutesClassified([smuggled])).toThrow(/no valid access class/);
  });

  it('standalone HTTP transport parity: identical status/body/Set-Cookie vs direct handle()', async () => {
    const own = makeMultiUserApp();
    const server = await own.app.listen(0);
    try {
      // Anonymous 401 parity.
      const direct = await own.app.handle(req('GET', '/api/runs'));
      const http = await fetch(`${server.url}/api/runs`);
      expect(http.status).toBe(direct.status);
      expect(await http.json()).toEqual(direct.body);

      // Bootstrap redeem over real HTTP: the Set-Cookie must reach the wire.
      const redeem = await fetch(`${server.url}/api/auth/invite/redeem`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: BOOTSTRAP, username: 'wire-admin', password: PASSWORD }),
      });
      expect(redeem.status).toBe(201);
      const setCookie = redeem.headers.get('set-cookie');
      expect(setCookie).toContain('__Host-sf_session=');

      const who = await fetch(`${server.url}/api/auth/identity`, {
        headers: { cookie: (setCookie ?? '').split(';')[0] },
      });
      expect(who.status).toBe(200);
    } finally {
      await server.close();
    }
  });
});
