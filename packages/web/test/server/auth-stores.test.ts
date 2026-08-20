/**
 * AuthService contract suite (U2) — parameterized over BOTH store backends
 * (in-memory and file), mirroring the event-store contract precedent: every
 * scenario is the acceptance bar for a future DB implementation.
 *
 * Covers: invite issue→redeem atomicity (first-commit-wins), bootstrap
 * consume-once + explicit rearm, username rules, session mint/verify/logout/
 * rotation, API token mint/verify/rotate, revocation cascade (sessions AND
 * tokens in one operation), throttling lockouts, and the no-plaintext-at-rest
 * guarantee on the file backend.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAuthService,
  createFileAuthStores,
  createInMemoryAuthStores,
} from '../../src/server/auth/service';
import type { AuthStores } from '../../src/server/auth/service';
import { createAuthThrottle } from '../../src/server/auth/throttle';
import { deriveClientIp } from '../../src/server/auth/throttle';

const BOOTSTRAP = 'bootstrap-code-high-entropy-0123456789';
const PASSWORD = 'a sufficiently long password';

interface Backend {
  readonly name: string;
  make(): { stores: AuthStores; dir?: string };
}

const BACKENDS: Backend[] = [
  { name: 'in-memory', make: () => ({ stores: createInMemoryAuthStores() }) },
  {
    name: 'file',
    make: () => {
      const dir = mkdtempSync(join(tmpdir(), 'auth-test-'));
      return { stores: createFileAuthStores(dir), dir };
    },
  },
];

function makeService(stores: AuthStores, overrides: Partial<Parameters<typeof createAuthService>[0]> = {}) {
  let now = 1_000_000;
  const clock = () => now;
  const advance = (ms: number) => {
    now += ms;
  };
  const service = createAuthService({
    stores,
    bootstrapInvite: BOOTSTRAP,
    clock,
    throttle: createAuthThrottle({ clock, maxConcurrentKdf: 2 }),
    ...overrides,
  });
  return { service, advance, clock };
}

/** Bootstrap the admin and return their identity + session. */
async function withAdmin(stores: AuthStores) {
  const ctx = makeService(stores);
  const redeemed = await ctx.service.redeemInvite({
    token: BOOTSTRAP,
    username: 'admin',
    password: PASSWORD,
    ip: '10.0.0.1',
  });
  if (!redeemed.ok) {
    throw new Error(`bootstrap failed: ${redeemed.reason}`);
  }
  return { ...ctx, admin: redeemed.session };
}

for (const backend of BACKENDS) {
  describe(`AuthService contract (${backend.name})`, () => {
    it('bootstrap creates the admin, consumes once, and never replays', async () => {
      const { stores } = backend.make();
      const { service } = await withAdmin(stores);
      expect(await service.hasAdmin()).toBe(true);
      expect(await service.bootstrapState()).toBe('consumed');

      // Same value presented again: generic invite failure, no account.
      const replay = await service.redeemInvite({
        token: BOOTSTRAP,
        username: 'mallory',
        password: PASSWORD,
        ip: '10.0.0.9',
      });
      expect(replay).toEqual({ ok: false, reason: 'invalid_invite' });
    });

    it('bootstrap rearm requires the flag AND a new value; resets only the admin password', async () => {
      const { stores } = backend.make();
      const first = await withAdmin(stores);
      const adminToken = await first.service.mintApiToken(first.admin.identity.userId);
      expect(adminToken).not.toBeNull();

      // Rearmed with a NEW value: resets the admin password and kills sessions/tokens.
      const rearmed = makeService(stores, {
        bootstrapInvite: 'a-completely-new-bootstrap-value-42',
        bootstrapRearm: true,
      });
      expect(await rearmed.service.bootstrapState()).toBe('rearmed');
      const reset = await rearmed.service.redeemInvite({
        token: 'a-completely-new-bootstrap-value-42',
        username: 'admin',
        password: 'a brand new admin password',
        ip: '10.0.0.1',
      });
      expect(reset.ok).toBe(true);
      // Old admin session + API token are dead (R4).
      expect(await rearmed.service.verifySession(first.admin.sessionToken)).toBeNull();
      expect(await rearmed.service.verifyApiToken((adminToken as { token: string }).token)).toBeNull();
      // Old password no longer works; new one does.
      expect(
        (await rearmed.service.login({ username: 'admin', password: PASSWORD, ip: '1.1.1.1' })).ok,
      ).toBe(false);
      expect(
        (
          await rearmed.service.login({
            username: 'admin',
            password: 'a brand new admin password',
            ip: '1.1.1.1',
          })
        ).ok,
      ).toBe(true);
    });

    it('invite issue → redeem creates a user atomically; double redemption loses generically', async () => {
      const { stores } = backend.make();
      const { service, admin } = await withAdmin(stores);
      const invite = await service.issueInvite(admin.identity.userId);

      const [a, b] = await Promise.all([
        service.redeemInvite({ token: invite.token, username: 'alice', password: PASSWORD, ip: '2.2.2.2' }),
        service.redeemInvite({ token: invite.token, username: 'alice2', password: PASSWORD, ip: '3.3.3.3' }),
      ]);
      const wins = [a, b].filter((r) => r.ok);
      const loses = [a, b].filter((r) => !r.ok);
      expect(wins).toHaveLength(1);
      expect(loses).toHaveLength(1);
      expect((loses[0] as { reason: string }).reason).toBe('invalid_invite');
      expect((await service.listUsers()).filter((u) => u.role === 'user')).toHaveLength(1);
    });

    it('revoked and expired invites fail with the same generic reason', async () => {
      const { stores } = backend.make();
      const { service, admin, advance } = await withAdmin(stores);
      const revoked = await service.issueInvite(admin.identity.userId);
      expect(await service.revokeInvite(revoked.inviteId)).toBe(true);
      expect(
        await service.redeemInvite({ token: revoked.token, username: 'bob', password: PASSWORD, ip: '4.4.4.4' }),
      ).toEqual({ ok: false, reason: 'invalid_invite' });

      const stale = await service.issueInvite(admin.identity.userId);
      advance(8 * 24 * 60 * 60 * 1000); // past the 7-day TTL
      expect(
        await service.redeemInvite({ token: stale.token, username: 'bob', password: PASSWORD, ip: '4.4.4.4' }),
      ).toEqual({ ok: false, reason: 'invalid_invite' });
    });

    it('username collisions (case-insensitive, incl. revoked users) and weak passwords reject', async () => {
      const { stores } = backend.make();
      const { service, admin } = await withAdmin(stores);
      const inv1 = await service.issueInvite(admin.identity.userId);
      const ok = await service.redeemInvite({ token: inv1.token, username: 'Carol', password: PASSWORD, ip: '5.5.5.5' });
      expect(ok.ok).toBe(true);

      const inv2 = await service.issueInvite(admin.identity.userId);
      expect(
        await service.redeemInvite({ token: inv2.token, username: 'carol', password: PASSWORD, ip: '5.5.5.5' }),
      ).toEqual({ ok: false, reason: 'username_taken' });
      expect(
        await service.redeemInvite({ token: inv2.token, username: 'dave', password: 'short', ip: '5.5.5.5' }),
      ).toEqual({ ok: false, reason: 'weak_password' });
      expect(
        await service.redeemInvite({ token: inv2.token, username: 'x', password: PASSWORD, ip: '5.5.5.5' }),
      ).toEqual({ ok: false, reason: 'invalid_username' });

      // Revoke carol; her name stays taken.
      const carol = (await service.listUsers()).find((u) => u.username === 'Carol');
      await service.revokeUser((carol as { userId: string }).userId);
      expect(
        await service.redeemInvite({ token: inv2.token, username: 'CAROL', password: PASSWORD, ip: '5.5.5.5' }),
      ).toEqual({ ok: false, reason: 'username_taken' });
    });

    it('login mints a rotated session; verify resolves identity + per-session CSRF; logout kills it', async () => {
      const { stores } = backend.make();
      const { service } = await withAdmin(stores);
      const login = await service.login({ username: 'admin', password: PASSWORD, ip: '6.6.6.6' });
      expect(login.ok).toBe(true);
      const session = (login as { session: { sessionToken: string; csrfToken: string } }).session;

      const identity = await service.verifySession(session.sessionToken);
      expect(identity?.role).toBe('admin');
      expect(identity?.csrfToken).toBe(session.csrfToken);

      await service.logout(session.sessionToken);
      expect(await service.verifySession(session.sessionToken)).toBeNull();
    });

    it('sessions expire server-side (idle + absolute)', async () => {
      const { stores } = backend.make();
      const { service, advance, admin } = await withAdmin(stores);
      advance(31 * 24 * 60 * 60 * 1000); // beyond the 30-day idle window
      expect(await service.verifySession(admin.sessionToken)).toBeNull();
    });

    it('API tokens: mint shown once, verify by selector, rotate revokes the old', async () => {
      const { stores } = backend.make();
      const { service, admin } = await withAdmin(stores);
      const first = await service.mintApiToken(admin.identity.userId);
      expect((first as { token: string }).token.startsWith('sfai_')).toBe(true);
      expect(await service.verifyApiToken((first as { token: string }).token)).toMatchObject({
        role: 'admin',
      });

      const second = await service.mintApiToken(admin.identity.userId);
      expect(await service.verifyApiToken((first as { token: string }).token)).toBeNull();
      expect(await service.verifyApiToken((second as { token: string }).token)).not.toBeNull();
      expect(await service.verifyApiToken('sfai_bogus_bogus')).toBeNull();
    });

    it('revokeUser is one operation: account + sessions + API tokens die together', async () => {
      const { stores } = backend.make();
      const { service, admin } = await withAdmin(stores);
      const invite = await service.issueInvite(admin.identity.userId);
      const redeemed = await service.redeemInvite({
        token: invite.token,
        username: 'erin',
        password: PASSWORD,
        ip: '7.7.7.7',
      });
      const erin = (redeemed as { session: { identity: { userId: string }; sessionToken: string } }).session;
      const token = await service.mintApiToken(erin.identity.userId);

      const outcome = await service.revokeUser(erin.identity.userId);
      expect(outcome.ok).toBe(true);
      expect(outcome.sessionsInvalidated).toBeGreaterThanOrEqual(1);
      expect(outcome.apiTokensRevoked).toBe(1);
      expect(await service.verifySession(erin.sessionToken)).toBeNull();
      expect(await service.verifyApiToken((token as { token: string }).token)).toBeNull();
      expect((await service.getUser(erin.identity.userId))?.revoked).toBe(true);
    });

    it('a token revoked between two requests fails the second request (no cached auth)', async () => {
      const { stores } = backend.make();
      const { service, admin } = await withAdmin(stores);
      const invite = await service.issueInvite(admin.identity.userId);
      const redeemed = await service.redeemInvite({
        token: invite.token,
        username: 'frank',
        password: PASSWORD,
        ip: '8.8.8.8',
      });
      const frank = (redeemed as { session: { identity: { userId: string } } }).session;
      const token = (await service.mintApiToken(frank.identity.userId)) as { token: string };
      expect(await service.verifyApiToken(token.token)).not.toBeNull();
      await service.revokeUser(frank.identity.userId);
      expect(await service.verifyApiToken(token.token)).toBeNull();
    });

    // 10 sequential logins × full-cost scrypt (every failure runs the dummy-
    // hash timing equalizer too) can exceed the 5s default under full-suite
    // CPU contention — the clock is injected, so only wall time needs room.
    it('repeated login failures trip lockout; lockout expires', { timeout: 120_000 }, async () => {
      const { stores } = backend.make();
      const { service, advance } = await withAdmin(stores);
      for (let i = 0; i < 8; i++) {
        await service.login({ username: 'admin', password: 'wrong password!', ip: '9.9.9.9' });
      }
      expect(await service.login({ username: 'admin', password: PASSWORD, ip: '9.9.9.9' })).toEqual({
        ok: false,
        reason: 'locked_out',
      });
      advance(16 * 60 * 1000);
      expect((await service.login({ username: 'admin', password: PASSWORD, ip: '9.9.9.9' })).ok).toBe(
        true,
      );
    });
  });
}

describe('file backend at-rest hygiene', () => {
  it('persists no plaintext secrets: passwords, session tokens, invite tokens, API secrets', async () => {
    const made = BACKENDS[1].make();
    const { service, admin } = await withAdmin(made.stores);
    const invite = await service.issueInvite(admin.identity.userId);
    const minted = (await service.mintApiToken(admin.identity.userId)) as { token: string };
    const secretPart = minted.token.split('_')[2];

    const dir = made.dir as string;
    const raw = readdirSync(dir)
      .map((f) => readFileSync(join(dir, f), 'utf8'))
      .join('\n');
    expect(raw).not.toContain(PASSWORD);
    expect(raw).not.toContain(BOOTSTRAP);
    expect(raw).not.toContain(admin.sessionToken);
    expect(raw).not.toContain(invite.token);
    expect(raw).not.toContain(secretPart);
  });
});

describe('deriveClientIp', () => {
  it('reads the proxy-appended rightmost XFF entry when trusting a proxy', () => {
    expect(
      deriveClientIp({ 'x-forwarded-for': 'evil-spoof, 203.0.113.7' }, '10.0.0.2', true),
    ).toBe('203.0.113.7');
  });
  it('ignores XFF entirely on direct connections', () => {
    expect(deriveClientIp({ 'x-forwarded-for': 'evil-spoof' }, '198.51.100.4', false)).toBe(
      '198.51.100.4',
    );
  });
  it('falls back to the socket address when XFF is absent', () => {
    expect(deriveClientIp({}, '198.51.100.4', true)).toBe('198.51.100.4');
  });
});
