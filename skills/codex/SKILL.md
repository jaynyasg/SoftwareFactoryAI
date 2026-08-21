---
name: software-factory-codex
description: >-
  Run the Software Factory from Codex (Windows/PowerShell). Submit a prompt
  or PRD and get back a real run with a ticket DAG, gate/preview/deploy evidence,
  a packaged repo, and a handoff summary — all produced by the same local or cloud backend
  the Factory Floor UI uses. Use when the user wants to build/scaffold an app via
  the software factory, create a factory run, or check a run's status/events/
  artifacts from Codex.
---

# Software Factory — Codex wrapper

This skill is a **thin wrapper** around the `software-factory` CLI and a local or
cloud backend. It does **not** implement its own supervisor, worker runner,
ledger, or packager — the CLI and API own all of that. The wrapper only:

1. ensures a backend is reachable (connect, or boot a local standalone one), and
2. forwards your prompt/PRD/sub-command to the CLI with `--caller-family codex`.

Passing `--caller-family codex` records nested-agent provenance on the run, so
that when a Codex worker adapter executes a ticket (live execution is optional/
manual in V1) the runner can attribute it as a nested Codex-in-Codex execution.

## Prerequisites

- The monorepo is installed (`pnpm install`).
- A backend reachable at `SF_BASE_URL` (default `http://127.0.0.1:3000`).
  - Local: the wrapper runs `software-factory start`, which connects if one is up
    or boots a standalone loopback backend.
  - Cloud: set `SF_BASE_URL` to the hosted factory URL and `SF_OPERATOR_TOKEN` to
    the server's token. Remote URLs are probed, not auto-spawned.
- If this skill is installed globally, the wrapper finds the repo via
  `SOFTWARE_FACTORY_REPO_ROOT`, the installer's `scripts/repo-root.txt`, or the
  current working directory.

## Invocation

The script lives at `scripts/software-factory.ps1` when installed, and at
`skills/codex/scripts/software-factory.ps1` inside this repo.

```powershell
# From a prompt (the common case):
./skills/codex/scripts/software-factory.ps1 "Build an AI services marketplace with providers and proposals"

# From a PRD file (its contents become the run prompt; the path is kept as prdRef):
./skills/codex/scripts/software-factory.ps1 run --prd ./docs/PRD.md

# From a JSON request body:
./skills/codex/scripts/software-factory.ps1 run --request '{"prompt":"...","reviewMode":"human"}'

# Inspect an existing run:
./skills/codex/scripts/software-factory.ps1 status <runId> --json
./skills/codex/scripts/software-factory.ps1 events <runId> --follow
./skills/codex/scripts/software-factory.ps1 artifacts <runId> --json
```

If the first argument is not one of `start|run|status|events|artifacts|help`, the
wrapper treats the whole argument list as a `run` (so a bare prompt works).

Add `--json` to get the machine-readable artifact contract on stdout (progress
and streamed events go to stderr, so stdout stays a single clean JSON document).

## Cloud invocation

```powershell
$env:SF_BASE_URL = 'https://your-factory.onrender.com'
$env:SF_OPERATOR_TOKEN = '<same value as the hosted SF_OPERATOR_TOKEN>'
software-factory.ps1 run "Build an AI services marketplace" --json
```

## Artifact output contract

`run` (and `status`) return the **same** object regardless of caller (web, CLI,
Claude, or Codex). With `--json` it is printed on stdout:

| Field                | Meaning                                                          |
| -------------------- | ---------------------------------------------------------------- |
| `runId`              | The created/queried run id.                                      |
| `status`             | Run status (V1 settles at `planned`).                            |
| `callerFamily`       | The initiating agent family (`codex` here).                      |
| `plannedTicketCount` | Number of tickets in the planned DAG.                            |
| `tickets[]`          | The ticket DAG: `id`, `title`, `state`, `riskTier`, `dependsOn`. |
| `previewUrl`         | Local preview URL (present once preview health passed).          |
| `hostedUrl`          | Hosted URL (present only after `deploy.hosted_ready`).           |
| `repoPath`           | Packaged repo artifact path.                                     |
| `handoffRef`         | Handoff markdown reference.                                      |
| `tests`              | Gate summary (`passed`/`failed`/`total`/`summary`/`gates[]`).    |
| `artifacts[]`        | Produced artifacts with confidence.                              |
| `eventsUrl`          | URL of the read-only event log for the run.                      |

In V1 the run flow is **planning-only**: a fresh run produces a ticket DAG and
settles at `planned`, so `previewUrl`/`hostedUrl`/`repoPath`/`handoffRef` are
`(pending)` until an (optional/manual) worker run produces those events. Use
`status`/`events`/`artifacts` to observe a run as it progresses.
