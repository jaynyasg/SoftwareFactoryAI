---
date: 2026-06-28
topic: full-factory-build-loop
title: Full Software Factory Build Loop Requirements
---

# Full Software Factory Build Loop Requirements

## Summary

Software Factory AI should evolve from a planning-first control room into a full
build factory that can research, plan, execute, verify, repair, package, and
deploy software runs while keeping every important decision and side effect in
the ledger.

---

## Problem Frame

The current product can accept a prompt or PRD, create a run, generate a
supervisor plan, emit a ticket DAG, and expose that blueprint through the UI,
CLI, API, ChatGPT action, and Claude/ChatGPT remote MCP paths. That is a strong
control plane, but it leaves the most valuable factory behavior outside the
default run path.

The missing loop is the assembly line: research what is needed, materialize a
workspace, assign tickets, run workers, verify output, repair failures, package
artifacts, and deploy. Without that loop, users still need another agent or human
to turn the blueprint into working software.

Deep research is part of the same gap. A factory that builds real products must
be able to investigate requirements, libraries, platform constraints, repo
conventions, API docs, competitors, examples, and unknowns before committing to
a plan. Research should not be a vague hidden step; it should be visible,
bounded, source-backed, and reusable by planners and workers.

---

## Key Decisions

- **Research is first-class ledger work.** Research findings, sources,
  assumptions, gaps, and enriched briefs must be recorded as events and projected
  into the run view.
- **Planning remains evidence-based.** The supervisor plan should consume the
  original prompt/PRD plus research output and repo context, then explain which
  evidence shaped the ticket DAG.
- **Execution is operator-controlled.** A run may start automatically when
  configured, but the system must support explicit start, pause, resume, cancel,
  and retry controls before worker execution is trusted.
- **Local-first and cloud-capable are both real modes.** Local runs can use local
  folders and local CLIs. Cloud runs need explicit GitHub/repo materialization,
  hosted secrets, and remote-compatible auth.
- **Workers use the same source of truth as the UI.** Worker progress, failures,
  retries, gates, packages, deploys, and handoffs must be projected from the
  ledger rather than invented by client state.
- **Autonomy is bounded by policy, not by optimistic UI.** Autonomous runs may
  continue through risk tiers where policy allows, but policy-blocked actions
  still stop.
- **The first complete path should be narrower than arbitrary software.** The
  AI Services Marketplace and existing TypeScript/Next patterns remain the
  proving ground before broad arbitrary-repo behavior is treated as reliable.

---

## Actors

- A1. Operator: the human who creates runs, reviews risk, starts or stops
  execution, inspects evidence, and accepts handoff.
- A2. Supervisor: the planner that turns intake, research, and repo context into
  a ticket DAG and operating brief.
- A3. Researcher: the factory stage that gathers external, repo, and PRD context
  with source evidence and bounded budgets.
- A4. Worker: a Codex, Claude, or API-backed execution adapter that performs a
  ticket inside the allowed workspace and tool boundary.
- A5. Gatekeeper: lint, typecheck, test, secret scan, preview, policy, and review
  stages that decide whether work can proceed.
- A6. Packager/deployer: the stage that creates provenance, handoff artifacts,
  Git outputs, and hosted deploys.
- A7. Web model caller: Claude.com or ChatGPT.com invoking the factory through a
  hosted connector rather than a local script.

---

## Requirements

**Deep Research And Discovery**

- R1. A run must support a deep research stage that can execute before
  supervisor planning and, when useful, during ticket execution.
- R2. Research must accept the original prompt, PRD reference, PRD text, GitHub
  repo, local folder, selected adapter, model profile, effort budget, and
  operator-specified constraints as context.
- R3. Research must produce an enriched build brief containing findings,
  assumptions, open questions, source summaries, citations or source references,
  and recommended planning implications.
- R4. Research must be bounded by configurable budgets such as effort, maximum
  sources, maximum time, and source type policy.
- R5. Research must distinguish verified facts, inferred conclusions, and
  unresolved unknowns so the planner and operator can treat them differently.
- R6. Research must be visible in the run blueprint, including source evidence
  and how it changed or confirmed the plan.

**Planning And Blueprint**

- R7. The supervisor must plan from the original intake plus the enriched brief,
  not only from the raw prompt/PRD.
- R8. The ticket DAG must preserve dependencies, risk tiers, write scopes,
  expected outputs, and gate expectations.
- R9. The UI must show a blueprint of the build while it is running: research,
  supervisor decisions, tickets, active workers, queues, gates, retries,
  packages, and deploy state.
- R10. The system must preserve planning-first behavior as a safe mode for users
  who want a blueprint without automatic execution.

**Workspace And Repo Materialization**

- R11. Local runs must be able to bind to a local folder that exists on the same
  machine as the factory runtime.
- R12. Cloud runs must materialize work from a GitHub repository or uploaded PRD
  content rather than assuming access to the user's laptop filesystem.
- R13. Repo materialization must record the repository, branch, commit, working
  directory, and checkout status as run evidence.
- R14. The system must protect host secrets and unrelated user files when
  materializing or executing a workspace.

**Execution Queue And Worker Orchestration**

- R15. A planned run must be startable into worker execution from the UI, CLI,
  HTTP API, and remote MCP/API callers when authorization allows it.
- R16. Execution must support pause, resume, cancel, retry ticket, retry failed
  stage, and rerun gates.
- R17. Worker concurrency must honor the requested cap up to 20 while adapting to
  ready tickets, adapter capacity, sandbox capacity, resource budget,
  write-scope conflicts, and review policy.
- R18. Worker assignment must be deterministic and explainable enough for the
  operator to understand why a ticket is queued, running, blocked, failed, or
  complete.
- R19. Worker execution must emit lifecycle events for adapter selection, start,
  progress, retry, completion, failure, cancellation, and produced artifacts.
- R20. The system must prevent concurrent workers from writing conflicting
  scopes unless an isolation strategy makes the conflict safe.

**Gates, Repair, And Review**

- R21. The build loop must run quality gates appropriate to the project,
  including lint, typecheck, tests, secret scan, dependency policy, and preview
  health where applicable.
- R22. Gate failures must be attached to the responsible ticket or stage with
  evidence, logs, and a retry/repair path.
- R23. Repair loops must be bounded to avoid infinite retries and must escalate
  to the operator when the retry budget is exhausted or policy requires review.
- R24. Human review mode must pause only where policy requires approval.
- R25. Autonomous review mode must continue through review risk tiers where
  policy allows, while policy-blocked actions remain blocked.

**Packaging, Provenance, And Deploy**

- R26. A successful build must produce a handoff package with source references,
  generated artifacts, gate evidence, provenance, confidence, and run summary.
- R27. Generated or modified code must be attributable to tickets, workers,
  sources, and gates.
- R28. Deploy must occur only after local completion criteria pass, review policy
  is satisfied, package/provenance exist, and hosted health checks pass.
- R29. Hosted URLs must appear only after the deployment provider and hosted
  health check both succeed.
- R30. Failed or incomplete deploys must not mark the whole local build as
  useless; they should surface retryable deploy state and preserve local
  artifacts.

**Cloud And Web Model Invocation**

- R31. Claude.com and ChatGPT.com must invoke the factory through hosted HTTPS
  connectors, not by assuming access to local scripts.
- R32. Remote MCP and GPT Action paths must expose enough tools to create,
  research, start, pause, resume, inspect, cancel, and retrieve artifacts for a
  run.
- R33. Remote web-model auth must support operator-token based development and an
  OAuth-compatible or proxy-compatible path for platforms that cannot send static
  headers.
- R34. Cloud execution must make GitHub repository materialization, secrets, and
  deploy credentials explicit setup requirements.

**Observability And Operations**

- R35. The operator view must show run state, queue state, worker capacity,
  adapter health, research state, gate status, deploy status, and recent ledger
  events without requiring scrolling through an unbounded run list.
- R36. The system must provide diagnostics for stuck queues, adapter setup/auth
  failure, sandbox fallback, repeated gate failure, deploy failure, and research
  source failures.
- R37. Every major state transition must be replayable from the ledger after a
  server restart.
- R38. The system must support single-instance operation first and define the
  migration path to database-backed event storage and durable queues for hosted
  scale.

---

## Key Flows

- F1. Research-first planning
  - **Trigger:** Operator submits a prompt, PRD, repo, or combination.
  - **Actors:** A1, A2, A3.
  - **Steps:** Create run, gather bounded research, produce enriched brief, plan
    ticket DAG, show blueprint.
  - **Outcome:** The operator sees what the factory learned and how that shaped
    the plan.

- F2. Operator-started build execution
  - **Trigger:** A planned run is ready and the operator starts execution.
  - **Actors:** A1, A4, A5.
  - **Steps:** Materialize workspace, enqueue ready tickets, start workers up to
    effective capacity, emit progress, run gates, repair or complete.
  - **Outcome:** Tickets move through queued, running, blocked, retrying, failed,
    cancelled, or completed states with ledger evidence.

- F3. Cloud web-model invocation
  - **Trigger:** Claude.com or ChatGPT.com calls a hosted factory connector.
  - **Actors:** A7, A2, A3, A4.
  - **Steps:** Authenticate, create run with repo/PRD context, research and plan,
    optionally start execution, return run status and events.
  - **Outcome:** The web model can use the factory as a remote build system
    without local filesystem access.

- F4. Gate failure and repair
  - **Trigger:** A gate fails after worker output.
  - **Actors:** A4, A5, A1.
  - **Steps:** Attach logs, classify failure, retry or create repair work, pause
    for review when required, resume after approval or fix.
  - **Outcome:** Failure becomes actionable work instead of an opaque terminal
    state.

- F5. Package and deploy
  - **Trigger:** All required tickets and local gates pass.
  - **Actors:** A5, A6, A1.
  - **Steps:** Create handoff package, compute provenance/confidence, push or
    prepare repo output, deploy if configured, verify hosted health.
  - **Outcome:** The operator receives local artifacts and, when deploy succeeds,
    a hosted URL backed by evidence.

---

## Acceptance Examples

- AE1. Covers R1, R3, R6. Given a prompt asking for a product that depends on
  unfamiliar platform constraints, when the run is created with research enabled,
  then the run shows source-backed findings and an enriched brief before or
  alongside the supervisor plan.
- AE2. Covers R10, R15. Given an operator chooses blueprint-only mode, when a run
  is created, then it stops at planned state until the operator explicitly starts
  execution.
- AE3. Covers R11, R12, R13. Given a cloud run includes a GitHub repo and a local
  folder path, when the run materializes its workspace, then GitHub repo checkout
  is used and the laptop-only path is reported as unavailable to the cloud
  runtime.
- AE4. Covers R17, R18, R20. Given 20 requested workers and 12 ready tickets with
  two write-scope conflicts, when execution starts, then effective capacity and
  queued tickets are explained in the operator view.
- AE5. Covers R21, R22, R23. Given a test gate fails after a worker completes,
  when the repair loop runs, then logs are attached, retry budget is visible, and
  unresolved failure escalates instead of looping forever.
- AE6. Covers R28, R29. Given local gates pass but hosted health fails, when
  deploy completes provider-side, then no hosted-ready URL is projected and the
  deploy state remains retryable with evidence.
- AE7. Covers R31, R32, R33. Given Claude.com calls the remote connector, when it
  asks to create and start a run, then the hosted factory authenticates the call,
  records the caller as remote API/MCP provenance, and returns inspectable run
  status.

---

## Success Criteria

- A new run can go from prompt/PRD through research, planning, execution, gates,
  package, and deploy without manual intervention except where policy requires
  review.
- The run blueprint shows research and execution progress clearly enough that an
  operator can answer "what is happening and why?" without reading raw logs.
- Research outputs cite or reference sources and clearly label assumptions and
  unresolved unknowns.
- Worker execution can be paused, cancelled, retried, and replayed from ledger
  state.
- Gate failures produce actionable repair work or human escalation.
- Claude.com and ChatGPT.com can invoke the hosted factory through documented
  connector paths.
- A restarted local or cloud single-instance factory can reconstruct run state
  from the ledger.

---

## Scope Boundaries

Deferred for later:

- Multi-tenant SaaS billing, quotas, teams, and abuse controls.
- Non-Render deploy provider adapters beyond the existing Render path.
- Automatic human-unapproved genome or skill mutation.
- Branch-per-ticket isolation unless required by write-scope safety findings.
- Full arbitrary-stack reliability guarantees.

Outside this product's identity:

- A generic chat agent that hides planning and execution evidence.
- A public unauthenticated build service.
- A deploy-only tool that ignores research, planning, gates, and provenance.
- A source browser that never executes work.

---

## Dependencies And Assumptions

- The existing event ledger remains the system of record.
- The existing worker scheduler, adapter contracts, gates, packaging, and Render
  deploy helpers are reusable foundations, even if they need integration work.
- Cloud execution requires explicit repository checkout or upload; cloud workers
  cannot directly access arbitrary local laptop paths.
- Some hosted web-model platforms may require an auth proxy or OAuth-compatible
  connector rather than static header configuration.
- External research providers and source-fetching capabilities must be chosen
  during planning based on available credentials and acceptable cost.

---

## Sources

- `README.md`
- `ARCHITECTURE.md`
- `TODOS.md`
- `docs/plans/2026-06-27-001-feat-software-factory-v1-plan.md`
- `docs/runbooks/cloud-deployment.md`
- `docs/runbooks/render-deployment.md`
- `packages/web/src/server/planner.ts`
- `packages/web/src/server/mcp.ts`
- `packages/worker/src/runner/scheduler.ts`
- `packages/worker/src/runner/capacity.ts`
