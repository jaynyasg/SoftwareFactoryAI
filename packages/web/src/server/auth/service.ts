/**
 * AuthService (U2): the OPERATION-LEVEL interface over the auth collections.
 *
 * Cross-store invariants live here as single operations — `redeemInvite`
 * atomically consumes the invite and creates (or resets) the account;
 * `revokeUser` invalidates sessions AND API tokens in one call — so routes
 * never compose multi-store sequences and a future DB swap replaces store
 * implementations, not call sites. Every mutating operation runs under one
 * serialized mutex (single-process, matching the ledger's single-writer
 * model), which is what makes invite redemption first-commit-wins.
 *
 * Failure results are typed and DELIBERATELY generic where an oracle would
 * leak (login and invite failures never reveal which part was wrong).
 */
import {
  hashPassword,
  verifyPassword,
} from '@software-factory/core';
import type { CollectionStore } from './stores';
import {
  INVITE_TTL_MS,
  MIN_BOOTSTRAP_LENGTH,
  MIN_PASSWORD_LENGTH,
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
  SESSION_TOUCH_INTERVAL_MS,
  hashesEqual,
  isValidUsername,
  mintApiTokenValue,
  newId,
  newOpaqueToken,
  normalizeUsername,
  parseApiTokenValue,
  sha256Hex,
} from './records';
import type {
  ApiTokenRecord,
  AuthMeta,
  Identity,
  InviteRecord,
  SessionRecord,
  UserAccount,
} from './records';
import type { AuthThrottle } from './throttle';
import { createAuthThrottle } from './throttle';
import { createFileCollectionStore, createInMemoryCollectionStore } from './stores';
import {
  isApiTokenRecord,
  isAuthMeta,
  isInviteRecord,
  isSessionRecord,
  isUserAccount,
} from './records';
import { join } from 'node:path';

/** In-memory store bundle (tests + contract-suite twin). */
export function createInMemoryAuthStores(): AuthStores {
  return {
    accounts: createInMemoryCollectionStore(),
    sessions: createInMemoryCollectionStore(),
    invites: createInMemoryCollectionStore(),
    apiTokens: createInMemoryCollectionStore(),
    meta: createInMemoryCollectionStore(),
  };
}

/** File-backed store bundle under `<factoryDir>/auth/`. */
export function createFileAuthStores(baseDir: string): AuthStores {
  return {
    accounts: createFileCollectionStore(join(baseDir, 'accounts.json'), isUserAccount),
    sessions: createFileCollectionStore(join(baseDir, 'sessions.json'), isSessionRecord),
    invites: createFileCollectionStore(join(baseDir, 'invites.json'), isInviteRecord),
    apiTokens: createFileCollectionStore(join(baseDir, 'api-tokens.json'), isApiTokenRecord),
    meta: createFileCollectionStore(join(baseDir, 'auth-meta.json'), isAuthMeta),
  };
}

export interface AuthStores {
  readonly accounts: CollectionStore<UserAccount>;
  readonly sessions: CollectionStore<SessionRecord>;
  readonly invites: CollectionStore<InviteRecord>;
  readonly apiTokens: CollectionStore<ApiTokenRecord>;
  readonly meta: CollectionStore<AuthMeta>;
}

export interface AuthServiceOptions {
  readonly stores: AuthStores;
  /** Env bootstrap invite value (hashed compare; consume-once). */
  readonly bootstrapInvite?: string;
  /** Explicit re-arm flag: allows the bootstrap to reset the admin password. */
  readonly bootstrapRearm?: boolean;
  readonly throttle?: AuthThrottle;
  readonly clock?: () => number;
}

/** A minted session, returned exactly once (cookie value + CSRF). */
export interface MintedSession {
  readonly sessionToken: string;
  readonly csrfToken: string;
  readonly identity: Identity;
}

export type LoginResult =
  | { readonly ok: true; readonly session: MintedSession }
  | { readonly ok: false; readonly reason: 'invalid_credentials' | 'locked_out' };

export type RedeemResult =
  | { readonly ok: true; readonly session: MintedSession }
  | {
      readonly ok: false;
      readonly reason: 'invalid_invite' | 'invalid_username' | 'username_taken' | 'weak_password' | 'locked_out';
    };

export interface MintedApiToken {
  /** Full token value — shown exactly once. */
  readonly token: string;
}

/** Presence-style view of a user for admin listings (no secrets). */
export interface UserView {
  readonly userId: string;
  readonly username: string;
  readonly role: 'admin' | 'user';
  readonly createdAt: number;
  readonly revoked: boolean;
  readonly hasApiToken: boolean;
}

export interface InviteView {
  readonly inviteId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly forUserId?: string;
  readonly status: 'open' | 'redeemed' | 'revoked' | 'expired';
}

export interface RevokeUserOutcome {
  readonly ok: boolean;
  /** Sessions/tokens invalidated (diagnostics for the caller's cascade). */
  readonly sessionsInvalidated: number;
  readonly apiTokensRevoked: number;
}

export interface AuthService {
  /** True once at least one (admin) account exists. */
  hasAdmin(): Promise<boolean>;
  /** Bootstrap state for diagnostics: armed / consumed / absent. NEVER the value. */
  bootstrapState(): Promise<'armed' | 'consumed' | 'absent' | 'rearmed'>;
  issueInvite(byUserId: string, forUserId?: string): Promise<{ inviteId: string; token: string }>;
  revokeInvite(inviteId: string): Promise<boolean>;
  listInvites(): Promise<readonly InviteView[]>;
  /** Atomic: validate invite (or bootstrap) + create/reset account + mint session. */
  redeemInvite(input: {
    token: string;
    username: string;
    password: string;
    ip: string;
  }): Promise<RedeemResult>;
  login(input: { username: string; password: string; ip: string }): Promise<LoginResult>;
  logout(sessionToken: string): Promise<void>;
  /** Live per-request identity resolution (no caching — R4 revocation guarantee). */
  verifySession(sessionToken: string): Promise<(Identity & { csrfToken: string }) | null>;
  verifyApiToken(token: string): Promise<Identity | null>;
  /** Mint (or rotate: mint new + revoke old) the user's API token. */
  mintApiToken(userId: string): Promise<MintedApiToken | null>;
  /** Revoke a user: account + sessions + API tokens in ONE operation. */
  revokeUser(userId: string): Promise<RevokeUserOutcome>;
  listUsers(): Promise<readonly UserView[]>;
  getUser(userId: string): Promise<UserView | null>;
}

// Dummy PHC hash for unknown-user logins (computed once, lazily) — keeps the
// login path's timing shape identical whether or not the username exists.
let dummyHashValue: string | null = null;
async function dummyHash(): Promise<string> {
  dummyHashValue ??= await hashPassword('dummy-timing-equalizer-password');
  return dummyHashValue;
}

export function createAuthService(options: AuthServiceOptions): AuthService {
  const { stores } = options;
  const clock = options.clock ?? Date.now;
  const throttle = options.throttle ?? createAuthThrottle({ clock });
  const bootstrapValue = options.bootstrapInvite?.trim();
  const bootstrapRearm = options.bootstrapRearm === true;

  // ONE mutex serializes every read-modify-write across the collections —
  // this is what makes redeemInvite first-commit-wins and revokeUser atomic.
  let chain: Promise<unknown> = Promise.resolve();
  function locked<T>(task: () => Promise<T>): Promise<T> {
    const result = chain.then(task, task);
    chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function activeAccounts(): Promise<readonly UserAccount[]> {
    return (await stores.accounts.load()).filter((a) => a.revokedAt === undefined);
  }

  function identityOf(account: UserAccount): Identity {
    return { userId: account.userId, username: account.username, role: account.role };
  }

  async function mintSessionFor(account: UserAccount): Promise<MintedSession> {
    const sessionToken = newOpaqueToken();
    const now = clock();
    const record: SessionRecord = {
      tokenHash: sha256Hex(sessionToken),
      userId: account.userId,
      csrfToken: newOpaqueToken(),
      createdAt: now,
      lastSeenAt: now,
    };
    const sessions = await stores.sessions.load();
    await stores.sessions.save([...sessions, record]);
    return { sessionToken, csrfToken: record.csrfToken, identity: identityOf(account) };
  }

  async function invalidateUserSessionsAndTokens(
    userId: string,
  ): Promise<{ sessions: number; tokens: number }> {
    const sessions = await stores.sessions.load();
    const remaining = sessions.filter((s) => s.userId !== userId);
    await stores.sessions.save(remaining);
    const tokens = await stores.apiTokens.load();
    let revoked = 0;
    const now = clock();
    const updated = tokens.map((t) => {
      if (t.userId === userId && t.revokedAt === undefined) {
        revoked += 1;
        return { ...t, revokedAt: now };
      }
      return t;
    });
    await stores.apiTokens.save(updated);
    return { sessions: sessions.length - remaining.length, tokens: revoked };
  }

  function inviteStatus(invite: InviteRecord, now: number): InviteView['status'] {
    if (invite.revokedAt !== undefined) {
      return 'revoked';
    }
    if (invite.redeemedAt !== undefined) {
      return 'redeemed';
    }
    if (invite.expiresAt <= now) {
      return 'expired';
    }
    return 'open';
  }

  /** Bootstrap redemption path: hashed compare, consume-once, explicit rearm. */
  async function tryBootstrap(
    token: string,
  ): Promise<{ kind: 'create-admin' } | { kind: 'reset-admin'; account: UserAccount } | null> {
    if (bootstrapValue === undefined || bootstrapValue.length < MIN_BOOTSTRAP_LENGTH) {
      return null;
    }
    if (!hashesEqual(sha256Hex(token), sha256Hex(bootstrapValue))) {
      return null;
    }
    const meta = (await stores.meta.load())[0];
    const consumedHash = meta?.bootstrapConsumedHash;
    const admins = (await activeAccounts()).filter((a) => a.role === 'admin');
    if (admins.length === 0) {
      // First boot: the code creates the admin (unless this exact value was
      // already consumed — a leaked old value never replays).
      if (consumedHash !== undefined && hashesEqual(consumedHash, sha256Hex(bootstrapValue))) {
        return null;
      }
      return { kind: 'create-admin' };
    }
    // Admin exists: only an explicit rearm with a NEW value resets them.
    if (!bootstrapRearm) {
      return null;
    }
    if (consumedHash !== undefined && hashesEqual(consumedHash, sha256Hex(bootstrapValue))) {
      return null;
    }
    return { kind: 'reset-admin', account: admins[0] };
  }

  async function consumeBootstrap(): Promise<void> {
    await stores.meta.save([
      { key: 'meta', bootstrapConsumedHash: sha256Hex(bootstrapValue as string) },
    ]);
  }

  return {
    async hasAdmin() {
      return (await activeAccounts()).some((a) => a.role === 'admin');
    },

    async bootstrapState() {
      if (bootstrapValue === undefined || bootstrapValue.length === 0) {
        return 'absent';
      }
      const meta = (await stores.meta.load())[0];
      if (
        meta?.bootstrapConsumedHash !== undefined &&
        hashesEqual(meta.bootstrapConsumedHash, sha256Hex(bootstrapValue))
      ) {
        return 'consumed';
      }
      return bootstrapRearm ? 'rearmed' : 'armed';
    },

    issueInvite(byUserId, forUserId) {
      return locked(async () => {
        const token = newOpaqueToken();
        const now = clock();
        const record: InviteRecord = {
          inviteId: newId('inv'),
          tokenHash: sha256Hex(token),
          createdBy: byUserId,
          createdAt: now,
          expiresAt: now + INVITE_TTL_MS,
          ...(forUserId !== undefined ? { forUserId } : {}),
        };
        const invites = await stores.invites.load();
        await stores.invites.save([...invites, record]);
        return { inviteId: record.inviteId, token };
      });
    },

    revokeInvite(inviteId) {
      return locked(async () => {
        const invites = await stores.invites.load();
        const target = invites.find((i) => i.inviteId === inviteId && i.revokedAt === undefined);
        if (target === undefined) {
          return false;
        }
        await stores.invites.save(
          invites.map((i) => (i.inviteId === inviteId ? { ...i, revokedAt: clock() } : i)),
        );
        return true;
      });
    },

    async listInvites() {
      const now = clock();
      return (await stores.invites.load()).map((invite) => ({
        inviteId: invite.inviteId,
        createdAt: invite.createdAt,
        expiresAt: invite.expiresAt,
        ...(invite.forUserId !== undefined ? { forUserId: invite.forUserId } : {}),
        status: inviteStatus(invite, now),
      }));
    },

    redeemInvite({ token, username, password, ip }) {
      return locked(async (): Promise<RedeemResult> => {
        if (throttle.isLocked(`redeem:${ip}`)) {
          return { ok: false, reason: 'locked_out' };
        }
        const fail = (
          reason: Exclude<RedeemResult & { ok: false }, never>['reason'],
        ): RedeemResult => {
          throttle.recordFailure(`redeem:${ip}`);
          return { ok: false, reason };
        };

        if (!isValidUsername(username)) {
          return fail('invalid_username');
        }
        if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
          return fail('weak_password');
        }

        const now = clock();
        const bootstrap = await tryBootstrap(token);
        if (bootstrap !== null) {
          const accounts = await stores.accounts.load();
          if (bootstrap.kind === 'create-admin') {
            const taken = accounts.some(
              (a) => normalizeUsername(a.username) === normalizeUsername(username),
            );
            if (taken) {
              return fail('username_taken');
            }
            const passwordHash = await throttle.withKdfSlot(() => hashPassword(password));
            const account: UserAccount = {
              userId: newId('usr'),
              username: username.trim(),
              passwordHash,
              role: 'admin',
              createdAt: now,
            };
            await stores.accounts.save([...accounts, account]);
            await consumeBootstrap();
            throttle.recordSuccess(`redeem:${ip}`);
            const session = await mintSessionFor(account);
            return { ok: true, session };
          }
          // reset-admin: password reset + invalidate sessions/tokens (R4).
          const passwordHash = await throttle.withKdfSlot(() => hashPassword(password));
          const updated = { ...bootstrap.account, passwordHash };
          await stores.accounts.save(
            accounts.map((a) => (a.userId === updated.userId ? updated : a)),
          );
          await invalidateUserSessionsAndTokens(updated.userId);
          await consumeBootstrap();
          throttle.recordSuccess(`redeem:${ip}`);
          const session = await mintSessionFor(updated);
          return { ok: true, session };
        }

        // Normal invite path. One generic failure for every invite problem —
        // used/revoked/expired/nonexistent are indistinguishable (no oracle).
        const tokenHash = sha256Hex(token);
        const invites = await stores.invites.load();
        const invite = invites.find((i) => hashesEqual(i.tokenHash, tokenHash));
        if (invite === undefined || inviteStatus(invite, now) !== 'open') {
          return fail('invalid_invite');
        }

        const accounts = await stores.accounts.load();
        if (invite.forUserId !== undefined) {
          // Re-invite (R4): reset the target account, preserve its data.
          const target = accounts.find(
            (a) => a.userId === invite.forUserId && a.revokedAt === undefined,
          );
          if (target === undefined) {
            return fail('invalid_invite');
          }
          const passwordHash = await throttle.withKdfSlot(() => hashPassword(password));
          const updated = { ...target, passwordHash };
          await stores.accounts.save(
            accounts.map((a) => (a.userId === updated.userId ? updated : a)),
          );
          await invalidateUserSessionsAndTokens(updated.userId);
          await stores.invites.save(
            invites.map((i) =>
              i.inviteId === invite.inviteId ? { ...i, redeemedAt: now } : i,
            ),
          );
          throttle.recordSuccess(`redeem:${ip}`);
          const session = await mintSessionFor(updated);
          return { ok: true, session };
        }

        // New account: username unique case-insensitively across live AND
        // revoked accounts (a revoked name never becomes impersonable).
        const taken = accounts.some(
          (a) => normalizeUsername(a.username) === normalizeUsername(username),
        );
        if (taken) {
          return fail('username_taken');
        }
        const passwordHash = await throttle.withKdfSlot(() => hashPassword(password));
        const account: UserAccount = {
          userId: newId('usr'),
          username: username.trim(),
          passwordHash,
          role: 'user',
          createdAt: now,
        };
        await stores.accounts.save([...accounts, account]);
        await stores.invites.save(
          invites.map((i) => (i.inviteId === invite.inviteId ? { ...i, redeemedAt: now } : i)),
        );
        throttle.recordSuccess(`redeem:${ip}`);
        const session = await mintSessionFor(account);
        return { ok: true, session };
      });
    },

    login({ username, password, ip }) {
      return locked(async (): Promise<LoginResult> => {
        const accountKey = `login:user:${normalizeUsername(username)}`;
        const ipKey = `login:ip:${ip}`;
        if (throttle.isLocked(accountKey) || throttle.isLocked(ipKey)) {
          return { ok: false, reason: 'locked_out' };
        }
        const account = (await activeAccounts()).find(
          (a) => normalizeUsername(a.username) === normalizeUsername(username),
        );
        // Constant-shape failure: run the KDF against a dummy hash when the
        // user is unknown so timing does not reveal username existence.
        const storedHash = account?.passwordHash ?? (await dummyHash());
        const verified =
          (await throttle.withKdfSlot(() => verifyPassword(password, storedHash))) &&
          account !== undefined;
        if (!verified) {
          throttle.recordFailure(accountKey);
          throttle.recordFailure(ipKey);
          return { ok: false, reason: 'invalid_credentials' };
        }
        throttle.recordSuccess(accountKey);
        throttle.recordSuccess(ipKey);
        // Rotation-at-login: a fresh session token every time (fixation-proof).
        const session = await mintSessionFor(account);
        return { ok: true, session };
      });
    },

    logout(sessionToken) {
      return locked(async () => {
        const hash = sha256Hex(sessionToken);
        const sessions = await stores.sessions.load();
        await stores.sessions.save(sessions.filter((s) => !hashesEqual(s.tokenHash, hash)));
      });
    },

    async verifySession(sessionToken) {
      if (typeof sessionToken !== 'string' || sessionToken.length === 0) {
        return null;
      }
      const now = clock();
      const hash = sha256Hex(sessionToken);
      const sessions = await stores.sessions.load();
      const record = sessions.find((s) => hashesEqual(s.tokenHash, hash));
      if (record === undefined) {
        return null;
      }
      if (now - record.lastSeenAt > SESSION_IDLE_MS || now - record.createdAt > SESSION_ABSOLUTE_MS) {
        await locked(async () => {
          const current = await stores.sessions.load();
          await stores.sessions.save(current.filter((s) => s.tokenHash !== record.tokenHash));
        });
        return null;
      }
      const account = (await activeAccounts()).find((a) => a.userId === record.userId);
      if (account === undefined) {
        return null;
      }
      // Sliding expiry with write throttling (persist at most hourly).
      if (now - record.lastSeenAt > SESSION_TOUCH_INTERVAL_MS) {
        await locked(async () => {
          const current = await stores.sessions.load();
          await stores.sessions.save(
            current.map((s) => (s.tokenHash === record.tokenHash ? { ...s, lastSeenAt: now } : s)),
          );
        });
      }
      return { ...identityOf(account), csrfToken: record.csrfToken };
    },

    async verifyApiToken(token) {
      const parsed = parseApiTokenValue(token);
      if (parsed === null) {
        return null;
      }
      const records = await stores.apiTokens.load();
      const record = records.find((t) => t.selector === parsed.selector);
      if (record === undefined || record.revokedAt !== undefined) {
        return null;
      }
      if (!hashesEqual(record.secretHash, sha256Hex(parsed.secret))) {
        return null;
      }
      const account = (await activeAccounts()).find((a) => a.userId === record.userId);
      return account === undefined ? null : identityOf(account);
    },

    mintApiToken(userId) {
      return locked(async () => {
        const account = (await activeAccounts()).find((a) => a.userId === userId);
        if (account === undefined) {
          return null;
        }
        const now = clock();
        const minted = mintApiTokenValue();
        const tokens = await stores.apiTokens.load();
        // Rotate semantics: revoke any live token for this user first.
        const updated = tokens.map((t) =>
          t.userId === userId && t.revokedAt === undefined ? { ...t, revokedAt: now } : t,
        );
        updated.push({
          selector: minted.selector,
          secretHash: sha256Hex(minted.secret),
          userId,
          createdAt: now,
        });
        await stores.apiTokens.save(updated);
        return { token: minted.token };
      });
    },

    revokeUser(userId) {
      return locked(async (): Promise<RevokeUserOutcome> => {
        const accounts = await stores.accounts.load();
        const target = accounts.find((a) => a.userId === userId && a.revokedAt === undefined);
        if (target === undefined) {
          return { ok: false, sessionsInvalidated: 0, apiTokensRevoked: 0 };
        }
        await stores.accounts.save(
          accounts.map((a) => (a.userId === userId ? { ...a, revokedAt: clock() } : a)),
        );
        const cascade = await invalidateUserSessionsAndTokens(userId);
        return { ok: true, sessionsInvalidated: cascade.sessions, apiTokensRevoked: cascade.tokens };
      });
    },

    async listUsers() {
      const accounts = await stores.accounts.load();
      const tokens = await stores.apiTokens.load();
      return accounts.map((a) => ({
        userId: a.userId,
        username: a.username,
        role: a.role,
        createdAt: a.createdAt,
        revoked: a.revokedAt !== undefined,
        hasApiToken: tokens.some((t) => t.userId === a.userId && t.revokedAt === undefined),
      }));
    },

    async getUser(userId) {
      return (await this.listUsers()).find((u) => u.userId === userId) ?? null;
    },
  };
}
