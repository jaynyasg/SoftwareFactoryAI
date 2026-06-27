# Runbook: Sandbox Troubleshooting

Diagnosing the sandbox that runs **generated-app** commands (install, lint,
typecheck, tests, secret-scan, dependency-audit, preview health). Generated code
is never trusted with host secrets; it runs in a Docker/WSL2 sandbox, or — only
with explicit policy allowance — a reduced-trust local fallback. Sandbox failure
classes are in [failure-taxonomy.md](./failure-taxonomy.md).

## Where sandbox health shows up

- **Operator dashboard** (`/operator`) → **Health** panel: the reduced-trust
  sandbox-fallback banner.
- **Run page**: the reduced-trust banner on the run summary; artifacts labeled
  **reduced trust**, with lowered confidence (`sandboxTrust` factor).
- **Setup checklist** → **Sandbox availability** item.
- **Ledger**: `sandbox.started`, `sandbox.fallback`, `sandbox.error`.

## Symptom → fix

### Sandbox fallback (reduced trust) — `sandbox.fallback`

Docker/WSL2 was unavailable, so generated commands ran in the policy-gated local
fallback. The run **continues**, but:

- artifacts are marked **reduced trust** and confidence is reduced
  (`sandboxTrust = 0.5`),
- the fallback is only permitted when policy/review allows it.

To restore full-trust runs:

1. Install and start **Docker Desktop** (or enable **WSL2** on Windows) and
   confirm `docker info` succeeds in the factory's shell.
2. Re-run. The ledger should show `sandbox.started` (not `sandbox.fallback`).
3. If you must proceed without a sandbox, ensure the reduced-trust fallback is
   explicitly allowed by policy — it is fail-closed by default.

### Sandbox error — `sandbox.error`

The sandbox failed to start or to run a command (blocking, retryable):

1. Check Docker/WSL2 is running and has CPU/memory/disk headroom.
2. Check the image/build is available and the workspace mount is valid.
3. Re-run, or allow the policy-gated local fallback if appropriate.

### A dependency change is blocked

The dependency policy (`packages/worker/src/sandbox/dependency-policy.ts`) blocks
unapproved higher-risk packages and requires review for dependency additions
above low risk. This is intentional. Review the dependency in the review studio,
approve if safe, and re-run — or remove the dependency.

### A command was blocked as unsafe (`security.block`)

The fail-closed boundary blocked host-secret access, a disallowed path, or a
data-loss migration. **Do not bypass.** Adjust the request or policy. See
[failure-taxonomy.md](./failure-taxonomy.md#securityblock).

## What the sandbox protects

- **Host secrets** are never mounted into generated-app commands; only the
  explicit deploy env is sent to Render.
- **Disallowed paths** outside the generated workspace are denied.
- **Data-loss migrations** require risk-aware review.
- **Reduced-trust fallback** is gated and clearly marked end-to-end.

## Related

- [failure-taxonomy.md](./failure-taxonomy.md) — sandbox + security failure classes.
- [adapter-troubleshooting.md](./adapter-troubleshooting.md) — control-plane CLIs.
- [render-deployment.md](./render-deployment.md) — hosted deploy env handling.
