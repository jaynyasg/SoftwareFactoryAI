# Runbook: Local Development

How to set up and work on the Software Factory locally.

## Prerequisites

| Tool    | Version  | Notes                                                                                                                        |
| ------- | -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Node.js | >= 22    | LTS recommended. Repo developed on Node 24.                                                                                  |
| pnpm    | >= 10    | `corepack enable` then `corepack prepare pnpm@latest --activate`, or install directly.                                       |
| Git     | >= 2.40  |                                                                                                                              |
| Docker  | optional | Enables the sandboxed gate runner (U6). Without it, the factory uses an explicit, policy-gated reduced-trust local fallback. |

## First-time setup

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
```

All four must pass on a clean checkout. CI runs the same commands
(`.github/workflows/ci.yml`).

## Repository layout

```text
packages/core    Shared contracts: events, projections, security, supervisor, genome, adapters, provenance, observability
packages/web     Next.js Factory Floor UI + local web/API server (loopback by default)
packages/worker  Worker runtime: scheduler, sandbox, gates, preview, packaging, deploy
packages/cli     `software-factory` CLI + Claude/Codex skill wrappers
factory-genome/  Versioned genome modules (module contracts, prompts, risk hints)
generated-app-template/  The AI Services Marketplace app the factory generates (NOT a workspace member)
docs/            design/, plans/, runbooks/
tests/e2e/       Playwright end-to-end suites
tests/fixtures/  Golden-run fixtures and test data
```

For hosted operation, see `docs/runbooks/cloud-deployment.md`. The same CLI and
skill wrappers can target a cloud backend with `SF_BASE_URL` and
`SF_OPERATOR_TOKEN`.

## Common commands

| Command                                     | What it does                                       |
| ------------------------------------------- | -------------------------------------------------- |
| `pnpm typecheck`                            | `tsc --noEmit` across every package                |
| `pnpm lint`                                 | ESLint (flat config) across the repo               |
| `pnpm test`                                 | Vitest unit/integration tests across every package |
| `pnpm test:e2e`                             | Playwright end-to-end suites                       |
| `pnpm build`                                | Per-package build (e.g. `next build` for web)      |
| `pnpm format`                               | Prettier write                                     |
| `pnpm dev`                                  | Start the Factory Floor web/API locally            |
| `pnpm --filter @software-factory/core test` | Run one package's tests                            |

## Module resolution (how the monorepo wires together)

Internal packages are **source-only** — `@software-factory/core` resolves directly to
its TypeScript source via the package `exports` field. There is no build step to run
before consuming a package:

- **Typecheck:** `tsconfig.base.json` `paths` map `@software-factory/*` to source.
- **Tests:** Vite resolves the package `exports` to source and transforms TS.
- **Runtime:** pnpm workspace symlinks + `tsx` execute the source directly.

## Operator token (preview)

The local web/API binds to loopback (`127.0.0.1`) by default. Mutating routes and CLI
commands require a local operator token/session plus origin, CSRF, and stale-command
checks. The token lifecycle and setup flow are implemented in U3; this section will be
expanded there.

## Troubleshooting

| Symptom                                                      | Fix                                                                                                                                                     |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install` blocks a build script                         | The repo allowlists required build scripts via `pnpm.onlyBuiltDependencies`. If a new dependency needs one, run `pnpm approve-builds` and add it there. |
| Typecheck can't find `@software-factory/core`                | Run `pnpm install` so workspace symlinks exist; confirm the importing package lists it under `dependencies`.                                            |
| `next build` / web typecheck complains about `next-env.d.ts` | It is committed for fresh-checkout typecheck; `next dev`/`next build` regenerates it. Do not delete it.                                                 |
| Vitest reports "No test files" failing a package             | Shared config sets `passWithNoTests: true`; ensure the package's `vitest.config.ts` extends `vitest.shared.ts`.                                         |
