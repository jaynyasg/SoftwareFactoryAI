---
title: "CLI ESM subpath export resolved to unbuilt dist, failing web tests in CI"
category: test-failures
module: ci-pipeline
date: 2026-08-21
problem_type: test_failure
component: development_workflow
severity: high
symptoms:
  - "Two web tests failed on Linux CI: daemon singleton — Next-mounted instance (instance.ts) and daemon singleton — standalone API server (standalone.ts) in packages/web/test/server/execution-daemon.test.ts"
  - "→ Cannot find package '@software-factory/cli/run-outputs' imported from '.../packages/web/src/server/routes/runs.ts'"
  - "WARN Failed to create bin at .../packages/web/node_modules/.bin/software-factory. ENOENT ... packages/cli/dist/index.js"
  - "core (233 + 4 skipped), cli (81), and worker were all GREEN — only those two web tests failed"
root_cause: missing_workflow_step
resolution_type: workflow_improvement
related_components:
  - tooling
  - testing_framework
tags:
  - ci-cd
  - pnpm-monorepo
  - esm
  - subpath-exports
  - tsup
  - vitest
  - dist-vs-src
  - build-step
---

# CLI ESM subpath export resolved to unbuilt dist, failing web tests in CI

## Problem

CI on the `Free` branch was red. `.github/workflows/ci.yml` installed
dependencies and jumped straight to `pnpm test` with no build step in between,
so the two `packages/web` tests that transitively import
`@software-factory/cli/run-outputs` failed on every run. A red pipeline blocks
every PR merge, so this one missing step gated the entire branch.

## Symptoms

- Exactly two web tests failed on Linux CI, both in
  [`packages/web/test/server/execution-daemon.test.ts`](../../../packages/web/test/server/execution-daemon.test.ts):
  `daemon singleton — Next-mounted instance (instance.ts)` and
  `daemon singleton — standalone API server (standalone.ts)`. Both passed
  locally.
- The failure message was a resolution error, not an assertion failure:
  `→ Cannot find package '@software-factory/cli/run-outputs' imported from '.../packages/web/src/server/routes/runs.ts'`.
- An install-time warning foreshadowed it:
  `WARN Failed to create bin at .../packages/web/node_modules/.bin/software-factory. ENOENT ... packages/cli/dist/index.js` —
  i.e. `packages/cli/dist/` did not exist yet.
- Every other package was green: `core` (233 passing + 4 skipped), `cli` (81),
  and `worker`. Only the two web tests failed.
- Earlier in the same debugging arc, the `Install pnpm` step itself failed with
  `ERR_PNPM_BAD_PM_VERSION` — a separate, prerequisite issue (see *What Didn't
  Work*).

## What Didn't Work

- **Treating it as a flaky or wrong test.** The first instinct — that the two
  daemon-singleton tests were brittle — was a false lead. The tests are
  correct: they assert the daemon-singleton contract and legitimately load
  [`packages/web/src/server/routes/runs.ts`](../../../packages/web/src/server/routes/runs.ts),
  which imports `buildRunOutputs` from `@software-factory/cli/run-outputs`.
  They passed *locally* only because a stale `packages/cli/dist/` from an
  earlier manual build happened to be present. Nothing was wrong with the
  tests; the environment differed.
- **Chasing the pnpm version error as if it were the root cause.** The
  `ERR_PNPM_BAD_PM_VERSION` at `Install pnpm` was a real but *separate*
  prerequisite: `pnpm/action-setup@v4` errors when pnpm is pinned in **two**
  places at once (a workflow `version:` input **and** `package.json`'s
  `packageManager` field). Fixing it (dropping `version:` from the workflow so
  `packageManager: pnpm@10.27.0` is the single source of truth) was necessary
  to get CI *running*, but it did not touch the test failure. Fixing it also
  surfaced two dormant issues once later steps could finally execute: a stale
  `push: [main]` trigger (the default branch is `Free`) and a `no-useless-escape`
  lint error in `packages/worker/test/git/git-publish.test.ts` that only ran
  once `pnpm lint` was reached.
- **Trusting the green `tsc` typecheck.** `pnpm typecheck` passed the whole
  time. That was misleading: TypeScript resolves the subpath through
  `tsconfig` path mappings (→ `src`), never through the package's `exports`
  map. "Compiles clean" said nothing about whether the module could be *loaded*
  at runtime.

## Solution

Add a **Build CLI** step to `.github/workflows/ci.yml`, after `Install
dependencies` and before `Typecheck`, so the CLI's `dist/` exists before any
consumer's tests run:

```yaml
      - name: Build CLI
        # @software-factory/cli/run-outputs is a dist/ subpath export; ESM
        # consumers (vitest, the web routes) resolve it via the "import"
        # condition to ./dist, so web tests that import it fail until the CLI
        # is built. core/worker export from src and need no build step.
        run: pnpm --filter @software-factory/cli run build
```

The full step order after the fix is: `Install pnpm` → `Install Node` →
`Install dependencies` → **`Build CLI`** → `Typecheck` → `Lint` → `Test`.

The local equivalent, for a fresh checkout or a new worktree, is the same
command after `pnpm install`:

```bash
pnpm --filter @software-factory/cli run build
```

Committed in `432c881` and merged to `Free` via merge commit `7244f1d`. CI went
green immediately afterward.

## Why This Works

The root cause is entirely in
[`packages/cli/package.json`](../../../packages/cli/package.json)'s `exports`
map:

```json
{
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./run-outputs": {
      "import": "./dist/run-outputs.js",
      "default": "./src/run-outputs.ts"
    }
  }
}
```

The `./run-outputs` subpath is *conditional*. Node's (and vitest's) resolver
picks a branch by matching **conditions** in order:

- The **`import`** condition matches whenever the importer uses ESM `import`
  (or dynamic `import()`).
- The **`default`** condition is the fallback that fires only when no earlier
  condition matched — in practice, for a CJS `require()`.

Because the whole workspace is `"type": "module"`, every internal consumer is
ESM, so **the `import` condition always wins** and resolution points at
`./dist/run-outputs.js`. The `default: ./src/run-outputs.ts` fallback is
effectively dead code for ESM — it would only be reached by a CJS `require`,
which nothing in this repo does. So the subpath **cannot load until tsup has
produced `dist/`**.

That explains every observation:

- **`tsc` passed** — TypeScript uses `tsconfig` path mappings, resolving to
  `src`, and never consults the `exports` map. Type-checking and runtime module
  resolution take different paths, so a green typecheck proves nothing about
  loadability.
- **`cli`'s own 81 tests passed without a build** — they run from inside the
  package against `src` directly (vitest resolves the package's *own* files by
  path, not through its published `exports`).
- **Only two web tests failed** — the web package is the *only* place that
  crosses the package boundary into that subpath, via `runs.ts`'s
  `import { buildRunOutputs } from '@software-factory/cli/run-outputs'`. The
  two daemon-singleton tests are the only ones that transitively load
  `runs.ts`.
- **`core` and `worker` were green** — they export from `src`, not from a
  `dist`-only subpath, so they have no build prerequisite.
- **It passed locally but failed in CI** — local machines had a leftover
  `packages/cli/dist/` from an earlier manual build; CI starts clean, so the
  missing build surfaced there first.

Adding the build step restores parity: `dist/run-outputs.js` (and
`dist/index.js`, which also clears the `.bin` ENOENT warning) exist before the
web tests run.

## Prevention

- **Keep CI in lockstep with the local runbook.** The failure was a CI/local
  drift: the local setup happened to have a stale `dist/`, so the missing step
  was invisible until a clean environment ran it. Any command required to make
  tests pass locally on a *fresh* checkout must appear in `ci.yml`.
- **General rule:** *any workspace package that ships a `dist`-only subpath
  export must be built before its consumers' tests run in CI.* Today that is
  only `@software-factory/cli`; `core` and `worker` export from `src` and need
  no build. If another package later adds a `dist`-only export, it needs the
  same treatment.
- **Prefer a durable mechanism over a hand-maintained step** if this recurs:
  either point the `import` condition at `src` for an internal ESM-only
  monorepo (so no build is needed to consume it), or add a root `pnpm -r build`
  / a `pretest` hook in `packages/web/package.json` so the build can never be
  forgotten. The single explicit `Build CLI` step was chosen for clarity and
  because only one package needs it right now.
- **Distrust green typechecks for runtime resolution questions.** `tsc`
  resolves via `tsconfig` paths, not the `exports` map — it will happily pass
  while a subpath is unloadable. When a module "won't load" but "compiles
  fine," suspect the `exports`/conditions map, not the types.
- **Read install-time `WARN`s.** The
  `Failed to create bin ... ENOENT ... packages/cli/dist/index.js` warning
  named the missing `dist/` directly, one step before the test failure.

## Related

- [`docs/runbooks/local-development.md`](../../runbooks/local-development.md) —
  its "Module resolution" section states internal packages are source-only with
  "no build step to run before consuming a package," which this issue
  contradicts for the CLI's `dist`-only subpath. Flagged for refresh.
- No related `docs/solutions/` entries — this is the first `test-failures/`
  document; the only pre-existing solution doc (video-as-code motion graphics)
  is unrelated.
- No related GitHub issues (the repository has none open).
