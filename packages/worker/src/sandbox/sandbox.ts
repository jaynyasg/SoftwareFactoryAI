/**
 * Sandbox contract + policy enforcement + implementation selection.
 *
 * Generated-app commands (install / lint / typecheck / test / preview) NEVER run
 * with ambient host trust. They run through a `Sandbox` that enforces a
 * `SandboxPolicy`:
 *   - host-secret protection: only an env allow-list is passed through, and any
 *     secret-named (or explicitly denied) variable is refused, so credentials in
 *     the operator's environment cannot leak into generated code, and
 *   - path containment: every cwd / declared path must resolve INSIDE the
 *     workspace dir — absolute escapes and `..` traversal are denied.
 *
 * `createSandbox` selects an implementation: a Docker/WSL2 container sandbox when
 * Docker is available (injectable detection), else a host-local fallback ONLY
 * when the policy/review explicitly permits it (marked REDUCED-TRUST), else a
 * refusal. `provisionSandbox` performs the selection AND emits the matching
 * ledger event (`sandbox.started` / `sandbox.fallback` / `sandbox.error`).
 *
 * Policy evaluation is pure and reused by both implementations; the only process
 * touch point is the injected `CommandRunner` (the same abstraction the CLI
 * adapters use), so every path is testable with a fake runner — no real Docker.
 */
import { isAbsolute, relative, resolve } from 'node:path';
import type {
  AppendableEvent,
  CommandRunner,
  EventActor,
  EventStore,
} from '@software-factory/core';
import { createDockerSandbox } from './docker-sandbox';
import { createLocalFallbackSandbox } from './local-fallback';

/** Which backend executed a command. */
export type SandboxMode = 'docker' | 'local-fallback';

/** A single policy denial against a command. */
export interface PolicyViolation {
  readonly kind:
    | 'denied_env'
    | 'path_escape'
    | 'absolute_path'
    | 'fallback_not_permitted'
    | 'sandbox_unavailable';
  /** The offending value (env var name or path). */
  readonly target: string;
  readonly reason: string;
}

/**
 * The policy a sandbox enforces. `workspaceDir` is the ONLY directory commands
 * may read/write within; everything else is fail-closed.
 */
export interface SandboxPolicy {
  /** The isolated workspace root. All paths must resolve within this. */
  readonly workspaceDir: string;
  /** Host env var names allowed to pass through (defaults to a minimal safe set). */
  readonly envAllowList?: readonly string[];
  /** Env var names always refused, even if allow-listed (explicit deny wins). */
  readonly deniedEnvVars?: readonly string[];
  /** Whether host-local fallback may be used when no container sandbox exists. */
  readonly allowFallback?: boolean;
  /** Allow container network access (default closed: `--network none`). */
  readonly networkAllowed?: boolean;
  /** Container image for the Docker sandbox (defaults to `DEFAULT_SANDBOX_IMAGE`). */
  readonly containerImage?: string;
}

/** A command to run inside the sandbox. Paths are validated against the policy. */
export interface SandboxCommand {
  readonly command: string;
  readonly args?: readonly string[];
  /** Working dir relative to (or absolute within) the workspace. Default `.`. */
  readonly cwd?: string;
  /** Extra paths the command will touch; each must stay within the workspace. */
  readonly paths?: readonly string[];
  /** Requested env overrides (subject to allow-list + deny rules). */
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly onOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void;
}

/** The outcome of a sandboxed command. Never throws for policy/exec failures. */
export interface SandboxRunResult {
  /** `true` only when the command ran AND exited 0 AND was not denied. */
  readonly ok: boolean;
  /** `true` when the policy refused the command (it did NOT run). */
  readonly denied: boolean;
  /** `true` when produced under the host-local fallback (reduced trust). */
  readonly reducedTrust: boolean;
  readonly mode: SandboxMode;
  readonly code?: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Policy violations (non-empty iff `denied`). */
  readonly violations: readonly PolicyViolation[];
  /** Human-facing reason for a denial / non-zero exit. */
  readonly reason?: string;
}

/** A policy-enforcing command runner scoped to one workspace. */
export interface Sandbox {
  readonly mode: SandboxMode;
  readonly reducedTrust: boolean;
  run(command: SandboxCommand): Promise<SandboxRunResult>;
}

/** Default container image used by the Docker sandbox when none is configured. */
export const DEFAULT_SANDBOX_IMAGE = 'node:22-bookworm-slim';

/** Minimal host env passed through when a policy does not specify an allow-list. */
export const DEFAULT_ENV_ALLOW_LIST: readonly string[] = [
  'PATH',
  'PATHEXT',
  'HOME',
  'USERPROFILE',
  'SystemRoot',
  'windir',
  'COMSPEC',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'NODE_ENV',
  'NODE_OPTIONS',
  'CI',
];

/** Names that look like host secrets and are refused unless explicitly allow-listed. */
export const SECRET_ENV_NAME_PATTERN =
  /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|ACCESS[_-]?KEY|API[_-]?KEY|SESSION|COOKIE|AUTH)/i;

/** Whether an env var name looks like a host secret. */
export function isSecretEnvName(name: string): boolean {
  return SECRET_ENV_NAME_PATTERN.test(name);
}

/** Whether a policy refuses an env var name (explicit deny, or secret + not allow-listed). */
export function isEnvKeyDenied(policy: SandboxPolicy, key: string): boolean {
  if (policy.deniedEnvVars?.includes(key)) {
    return true;
  }
  const allowList = policy.envAllowList ?? DEFAULT_ENV_ALLOW_LIST;
  if (allowList.includes(key)) {
    return false;
  }
  return isSecretEnvName(key);
}

/** Resolve a candidate path against the workspace and report containment. */
export function resolveWithinWorkspace(
  workspaceDir: string,
  candidate: string,
): { readonly ok: boolean; readonly resolved: string } {
  const base = resolve(workspaceDir);
  const resolved = resolve(base, candidate);
  const rel = relative(base, resolved);
  const ok = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  return { ok, resolved };
}

function checkPath(workspaceDir: string, candidate: string): PolicyViolation | undefined {
  const { ok } = resolveWithinWorkspace(workspaceDir, candidate);
  if (ok) {
    return undefined;
  }
  return {
    kind: isAbsolute(candidate) ? 'absolute_path' : 'path_escape',
    target: candidate,
    reason: `Path "${candidate}" escapes the sandbox workspace.`,
  };
}

/** The resolved env + cwd for an allowed command, plus any policy violations. */
export interface ResolvedEnv {
  readonly env: Record<string, string>;
  readonly violations: PolicyViolation[];
}

/**
 * Build the child env: pass through ONLY allow-listed host vars, then apply
 * explicit overrides — refusing any override that targets a denied/secret name.
 */
export function resolvePolicyEnv(
  policy: SandboxPolicy,
  hostEnv: Readonly<Record<string, string | undefined>>,
  requestedEnv?: Readonly<Record<string, string>>,
): ResolvedEnv {
  const allowList = policy.envAllowList ?? DEFAULT_ENV_ALLOW_LIST;
  const env: Record<string, string> = {};
  const violations: PolicyViolation[] = [];

  for (const key of allowList) {
    if (policy.deniedEnvVars?.includes(key)) {
      continue;
    }
    const value = hostEnv[key];
    if (typeof value === 'string') {
      env[key] = value;
    }
  }

  for (const [key, value] of Object.entries(requestedEnv ?? {})) {
    if (isEnvKeyDenied(policy, key)) {
      violations.push({
        kind: 'denied_env',
        target: key,
        reason: `Environment variable "${key}" is denied by the sandbox policy (host-secret protection).`,
      });
      continue;
    }
    env[key] = value;
  }

  return { env, violations };
}

/** A command validated against the policy: violations + the env/cwd to run with. */
export interface ValidatedCommand {
  readonly violations: PolicyViolation[];
  readonly env: Record<string, string>;
  /** Absolute, workspace-contained cwd. */
  readonly cwd: string;
}

/** Pure policy check shared by every sandbox implementation. */
export function validateCommandAgainstPolicy(
  policy: SandboxPolicy,
  command: SandboxCommand,
  hostEnv: Readonly<Record<string, string | undefined>>,
): ValidatedCommand {
  const violations: PolicyViolation[] = [];

  const cwdCandidate = command.cwd ?? '.';
  const cwdCheck = resolveWithinWorkspace(policy.workspaceDir, cwdCandidate);
  if (!cwdCheck.ok) {
    violations.push({
      kind: isAbsolute(cwdCandidate) ? 'absolute_path' : 'path_escape',
      target: cwdCandidate,
      reason: `Working directory "${cwdCandidate}" escapes the sandbox workspace.`,
    });
  }

  for (const path of command.paths ?? []) {
    const violation = checkPath(policy.workspaceDir, path);
    if (violation) {
      violations.push(violation);
    }
  }

  const { env, violations: envViolations } = resolvePolicyEnv(policy, hostEnv, command.env);
  violations.push(...envViolations);

  return { violations, env, cwd: cwdCheck.resolved };
}

/** Build a denial result (the command did not run). */
export function denialResult(
  mode: SandboxMode,
  reducedTrust: boolean,
  violations: readonly PolicyViolation[],
): SandboxRunResult {
  return {
    ok: false,
    denied: true,
    reducedTrust,
    mode,
    stdout: '',
    stderr: '',
    violations,
    reason: violations.map((v) => v.reason).join(' '),
  };
}

/** Wrap a terminal command result as a sandbox result. */
export function toSandboxResult(
  mode: SandboxMode,
  reducedTrust: boolean,
  result: { readonly code: number; readonly stdout: string; readonly stderr: string },
): SandboxRunResult {
  return {
    ok: result.code === 0,
    denied: false,
    reducedTrust,
    mode,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    violations: [],
    reason: result.code === 0 ? undefined : `Command exited with code ${result.code}.`,
  };
}

/* ----------------------------------------------------------------------------
 * Implementation selection
 * ------------------------------------------------------------------------- */

/** Injectable Docker-availability probe (true when a container sandbox is usable). */
export type DockerDetector = (runner: CommandRunner, signal?: AbortSignal) => Promise<boolean>;

/** Default Docker detection: `docker version` succeeds with a server version. */
export const detectDockerAvailable: DockerDetector = async (runner, signal) => {
  try {
    const result = await runner.run('docker', ['version', '--format', '{{.Server.Version}}'], {
      signal,
      timeoutMs: 5000,
    });
    return result.code === 0 && result.stdout.trim().length > 0;
  } catch {
    return false;
  }
};

/** The outcome of selecting a sandbox implementation. */
export type SandboxSelection =
  | {
      readonly ok: true;
      readonly sandbox: Sandbox;
      readonly mode: SandboxMode;
      readonly reducedTrust: boolean;
      /** `true` when the host-local fallback was selected. */
      readonly fallbackUsed: boolean;
      /** Why the fallback was needed (present iff `fallbackUsed`). */
      readonly fallbackReason?: string;
    }
  | {
      readonly ok: false;
      readonly fallbackRefused: true;
      readonly reason: string;
    };

/** Options for selecting a sandbox implementation. */
export interface CreateSandboxOptions {
  readonly policy: SandboxPolicy;
  readonly runner: CommandRunner;
  /** Injectable Docker detection (default probes via the runner). */
  readonly detectDocker?: DockerDetector;
  /** Host environment used for env filtering (default `process.env`). */
  readonly hostEnv?: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
}

/**
 * Select a sandbox implementation. Prefers a container sandbox; falls back to
 * host-local ONLY when the policy permits it (reduced trust); otherwise refuses.
 */
export async function createSandbox(options: CreateSandboxOptions): Promise<SandboxSelection> {
  const detect = options.detectDocker ?? detectDockerAvailable;
  const hostEnv = options.hostEnv ?? process.env;
  const dockerAvailable = await detect(options.runner, options.signal);

  if (dockerAvailable) {
    return {
      ok: true,
      sandbox: createDockerSandbox({ policy: options.policy, runner: options.runner, hostEnv }),
      mode: 'docker',
      reducedTrust: false,
      fallbackUsed: false,
    };
  }

  if (options.policy.allowFallback === true) {
    const fallbackReason =
      'Container sandbox (Docker/WSL2) is unavailable; using policy-permitted host-local fallback.';
    return {
      ok: true,
      sandbox: createLocalFallbackSandbox({
        policy: options.policy,
        runner: options.runner,
        hostEnv,
      }),
      mode: 'local-fallback',
      reducedTrust: true,
      fallbackUsed: true,
      fallbackReason,
    };
  }

  return {
    ok: false,
    fallbackRefused: true,
    reason:
      'Container sandbox is unavailable and host-local fallback is not permitted by policy/review.',
  };
}

/** Params for selecting AND recording a sandbox on the ledger. */
export interface ProvisionSandboxParams extends CreateSandboxOptions {
  readonly runId: string;
  readonly ticketId?: string;
  readonly clock?: () => number;
}

/** Dependencies for `provisionSandbox`. */
export interface ProvisionSandboxDeps {
  readonly store: EventStore;
}

/**
 * Select a sandbox and emit the matching ledger event:
 *   docker available  -> `sandbox.started` { mode }
 *   fallback (permitted) -> `sandbox.fallback` { reason, reducedTrust: true }
 *   fallback refused   -> `sandbox.error` { reason }
 */
export async function provisionSandbox(
  params: ProvisionSandboxParams,
  deps: ProvisionSandboxDeps,
): Promise<SandboxSelection> {
  const selection = await createSandbox(params);
  const actor: EventActor = { kind: 'sandbox', id: 'sandbox', display: 'sandbox' };

  const append = (event: Omit<AppendableEvent, 'runId' | 'ticketId'>): Promise<unknown> =>
    deps.store.append({
      ...event,
      runId: params.runId,
      ticketId: params.ticketId,
      timestamp: params.clock?.(),
    } as AppendableEvent);

  if (selection.ok && selection.fallbackUsed) {
    await append({
      type: 'sandbox.fallback',
      actor,
      subject: { kind: 'sandbox', id: 'sandbox' },
      severity: 'warn',
      payload: {
        reason: selection.fallbackReason ?? 'Host-local fallback in use.',
        reducedTrust: true,
      },
    });
  } else if (selection.ok) {
    await append({
      type: 'sandbox.started',
      actor,
      subject: { kind: 'sandbox', id: 'sandbox' },
      severity: 'info',
      payload: { mode: selection.mode },
    });
  } else {
    await append({
      type: 'sandbox.error',
      actor,
      subject: { kind: 'sandbox', id: 'sandbox' },
      severity: 'error',
      payload: { reason: selection.reason },
    });
  }

  return selection;
}
