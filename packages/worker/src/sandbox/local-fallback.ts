/**
 * Host-local fallback sandbox (REDUCED TRUST).
 *
 * Used ONLY when no container sandbox is available AND the policy/review has
 * explicitly permitted fallback (`SandboxPolicy.allowFallback`). It still applies
 * the SAME pure policy check as the container sandbox — host-secret env vars are
 * stripped/refused and every path must stay inside the workspace — but commands
 * run directly on the host (no container isolation), so every result is marked
 * `reducedTrust: true`. The selector (`createSandbox`) only hands this out behind
 * the explicit allowance, and the caller emits `sandbox.fallback`
 * (`reducedTrust: true`) so the reduced-trust posture is visible on the ledger
 * and flows into artifact-confidence scoring.
 */
import { resolve } from 'node:path';
import type { CommandRunner } from '@software-factory/core';
import { denialResult, toSandboxResult, validateCommandAgainstPolicy } from './sandbox';
import type { Sandbox, SandboxCommand, SandboxPolicy, SandboxRunResult } from './sandbox';

/** Options for constructing a host-local fallback sandbox. */
export interface LocalFallbackSandboxOptions {
  readonly policy: SandboxPolicy;
  readonly runner: CommandRunner;
  /** Host env used for allow-list passthrough (default `process.env`). */
  readonly hostEnv?: Readonly<Record<string, string | undefined>>;
}

/** Create the reduced-trust, host-local fallback sandbox. */
export function createLocalFallbackSandbox(options: LocalFallbackSandboxOptions): Sandbox {
  const hostEnv = options.hostEnv ?? process.env;

  return {
    mode: 'local-fallback',
    reducedTrust: true,
    async run(command: SandboxCommand): Promise<SandboxRunResult> {
      const validated = validateCommandAgainstPolicy(options.policy, command, hostEnv);
      if (validated.violations.length > 0) {
        return denialResult('local-fallback', true, validated.violations);
      }

      try {
        const result = await options.runner.run(command.command, command.args ?? [], {
          cwd: resolve(validated.cwd),
          // `validated.env` is the policy-resolved allow-list (no host secrets).
          // Pass it as the EXCLUSIVE child env so the host environment — including
          // API keys/tokens outside the allow-list — never reaches generated code.
          env: validated.env,
          replaceEnv: true,
          signal: command.signal,
          timeoutMs: command.timeoutMs,
          onOutput: command.onOutput,
        });
        return toSandboxResult('local-fallback', true, result);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          denied: false,
          reducedTrust: true,
          mode: 'local-fallback',
          stdout: '',
          stderr: reason,
          violations: [],
          reason: `Host-local fallback execution failed: ${reason}`,
        };
      }
    },
  };
}
