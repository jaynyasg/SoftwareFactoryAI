# ChatGPT.com Remote MCP Connector

ChatGPT.com cannot run this repo's local shell scripts. To call the factory from
ChatGPT web integrations that support remote MCP, deploy the factory to a public
HTTPS URL and point the integration at:

```text
https://your-factory.example.com/mcp
```

For Custom GPT Actions (OpenAPI instead of MCP), use
`integrations/chatgpt/actions.openai.yaml` — it declares the same lifecycle
operations over the same guarded HTTP routes.

## Tools

The endpoint exposes the full run lifecycle. Every tool is a thin adapter over
the same guarded HTTP API the UI and CLI use, so authorization, idempotency,
and stale-version behavior are identical across surfaces.

Create and inspect:

- `software_factory_create_run` — create a run from a prompt/PRD; `mode`
  selects `plan-only` (default), `research-and-plan`, or
  `research-plan-and-start`.
- `software_factory_list_runs` — projected runs, most recent first.
- `software_factory_get_run` — one projected run (concise summary plus links).
- `software_factory_get_events` — the ordered ledger event log (the explicit
  detail read; other tools return summaries, not event dumps).

Execution lifecycle (guarded, idempotent — repeated starts/retries return the
existing queue state instead of duplicating work):

- `software_factory_start_run` — preflight rehearsal, then enqueue execution.
- `software_factory_pause_run` / `software_factory_resume_run`
- `software_factory_cancel_run` — propagates to queued and active work.
- `software_factory_retry_run` — bounded retry, optionally one ticket.
- `software_factory_rerun_gates` — enqueue a quality-gate re-run.
- `software_factory_get_execution` — queue job, lease, preflight, and open
  interventions for a run.

Research, contract, and preflight:

- `software_factory_trigger_research` — one bounded, source-backed research
  pass; repeated triggers return the existing projected research.
- `software_factory_get_research` — sources, findings, assumptions, gaps, and
  the enriched brief.
- `software_factory_get_contract` — the build contract (scope, workspace,
  write boundaries, risks, gates, deploy target, completion criteria).
- `software_factory_get_preflight` — the latest dry-run rehearsal outcome and
  the interventions blocking a start.

Interventions and outputs:

- `software_factory_list_interventions` — the operator intervention queue,
  filterable by run, kind, severity, blocking stage, and open-only.
- `software_factory_resolve_intervention` — resolve one intervention;
  resolving twice returns the already-resolved state.
- `software_factory_get_outputs` — the run artifact contract: package path,
  handoff and provenance references, gate evidence, deploy state, and a hosted
  URL only after hosted health passed.
- `software_factory_get_setup` — cloud/local setup diagnostics. Source
  checkout, deploy, and research provider credentials are reported as three
  SEPARATE surfaces, by presence only — secret values are never emitted.

## Authentication

Tool calls require the hosted factory's operator token. The MCP bridge accepts
either:

```text
Authorization: Bearer <SF_OPERATOR_TOKEN>
```

or:

```text
x-operator-token: <SF_OPERATOR_TOKEN>
```

If the ChatGPT integration you are using requires OAuth rather than a static
header, put the factory behind an OAuth/auth proxy that terminates the
platform's OAuth flow and injects the operator token before forwarding to
`/mcp`. The reference proxy shape and hardening notes live in
`docs/runbooks/cloud-deployment.md` under "OAuth / Auth-Proxy Compatibility".

## Smoke Test

After deploying the factory, test the endpoint with a raw MCP request:

```bash
curl "$SF_BASE_URL/mcp" \
  -H "content-type: application/json" \
  -H "authorization: Bearer $SF_OPERATOR_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Create a research-backed run through MCP:

```bash
curl "$SF_BASE_URL/mcp" \
  -H "content-type: application/json" \
  -H "authorization: Bearer $SF_OPERATOR_TOKEN" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"software_factory_create_run","arguments":{"prompt":"Build an AI services marketplace","mode":"research-and-plan","requestedWorkerCap":10}}}'
```

Read the run's artifact contract once it completes:

```bash
curl "$SF_BASE_URL/mcp" \
  -H "content-type: application/json" \
  -H "authorization: Bearer $SF_OPERATOR_TOKEN" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"software_factory_get_outputs","arguments":{"runId":"<run-id>"}}}'
```
