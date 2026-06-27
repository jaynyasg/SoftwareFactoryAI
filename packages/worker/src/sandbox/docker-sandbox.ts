/**
 * Docker/WSL2-backed sandbox.
 *
 * When Docker is available (detected via the injected `CommandRunner` — see
 * `detectDockerAvailable`), generated-app commands run inside a container scoped
 * to the workspace: the workspace is bind-mounted read/write at a fixed mount
 * point, the working dir is set inside that mount, the network is closed by
 * default, and ONLY the policy-resolved env is forwarded as `--env` flags. The
 * same pure policy check (`validateCommandAgainstPolicy`) gates the command, so a
 * host-secret env var or a workspace-escaping path is refused before any `docker
 * run` is issued.
 *
 * This module never touches the OS directly; it builds a `docker run …` argv and
 * delegates to the runner, so tests drive it with a fake runner (no real Docker).
 */
import { resolve } from 'node:path';
import type { CommandRunner } from '@software-factory/core';
import {
  DEFAULT_SANDBOX_IMAGE,
  denialResult,
  toSandboxResult,
  validateCommandAgainstPolicy,
} from './sandbox';
import type { Sandbox, SandboxCommand, SandboxPolicy, SandboxRunResult } from './sandbox';

/** Mount point for the workspace inside the container. */
export const CONTAINER_WORKSPACE = '/workspace';

/** Options for constructing a Docker sandbox. */
export interface DockerSandboxOptions {
  readonly policy: SandboxPolicy;
  readonly runner: CommandRunner;
  /** Host env used for allow-list passthrough (default `process.env`). */
  readonly hostEnv?: Readonly<Record<string, string | undefined>>;
}

/**
 * Translate a sandbox command + resolved env into a `docker run` argv that mounts
 * the workspace and runs the command inside it.
 */
export function buildDockerArgs(
  policy: SandboxPolicy,
  command: SandboxCommand,
  env: Readonly<Record<string, string>>,
): string[] {
  const workspaceAbs = resolve(policy.workspaceDir);
  // Resolve the requested cwd to a path INSIDE the container mount.
  const relCwd = command.cwd === undefined || command.cwd === '.' ? '' : command.cwd;
  const containerCwd =
    relCwd === '' ? CONTAINER_WORKSPACE : `${CONTAINER_WORKSPACE}/${relCwd.replace(/\\/g, '/')}`;

  const args: string[] = [
    'run',
    '--rm',
    '--network',
    policy.networkAllowed === true ? 'bridge' : 'none',
    '-w',
    containerCwd,
    '-v',
    `${workspaceAbs}:${CONTAINER_WORKSPACE}`,
  ];

  for (const [key, value] of Object.entries(env)) {
    args.push('--env', `${key}=${value}`);
  }

  args.push(
    policy.containerImage ?? DEFAULT_SANDBOX_IMAGE,
    command.command,
    ...(command.args ?? []),
  );
  return args;
}

/** Create a Docker/WSL2-backed sandbox (reduced trust is always false here). */
export function createDockerSandbox(options: DockerSandboxOptions): Sandbox {
  const hostEnv = options.hostEnv ?? process.env;

  return {
    mode: 'docker',
    reducedTrust: false,
    async run(command: SandboxCommand): Promise<SandboxRunResult> {
      const validated = validateCommandAgainstPolicy(options.policy, command, hostEnv);
      if (validated.violations.length > 0) {
        return denialResult('docker', false, validated.violations);
      }

      const args = buildDockerArgs(options.policy, command, validated.env);
      try {
        const result = await options.runner.run('docker', args, {
          // The docker CLI itself runs on the host; only the container sees `env`.
          signal: command.signal,
          timeoutMs: command.timeoutMs,
          onOutput: command.onOutput,
        });
        return toSandboxResult('docker', false, result);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          denied: false,
          reducedTrust: false,
          mode: 'docker',
          stdout: '',
          stderr: reason,
          violations: [],
          reason: `Docker sandbox execution failed: ${reason}`,
        };
      }
    },
  };
}
