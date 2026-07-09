# Runbook: Cloud-Capable Factory

The factory can run as a hosted single-instance Node service. The current cloud
shape is intentionally conservative:

- one web/API process,
- a persistent JSONL event ledger on disk,
- a stable `SF_OPERATOR_TOKEN` for CLI/skill callers,
- same-host browser origin checks plus CSRF for UI mutations.

This is also the shape required for web-model access: ChatGPT.com and Claude.com
cannot run local skill scripts, so they need public HTTPS endpoints they can call
from their own cloud.

Horizontal scaling needs a database-backed event store and a worker queue; do
not run more than one instance against the same JSONL ledger.

## Render Deployment

The root `render.yaml` deploys the factory itself:

```yaml
buildCommand: corepack enable && corepack pnpm@10.27.0 install --frozen-lockfile && corepack pnpm@10.27.0 --filter @software-factory/web build
startCommand: corepack pnpm@10.27.0 --filter @software-factory/web start -- -H 0.0.0.0 -p $PORT
healthCheckPath: /api/setup
```

It also mounts a persistent disk at `/var/data` and stores the factory ledger in
`/var/data/.factory`.

Required env:

| Key                                 | Purpose                                                                            |
| ----------------------------------- | ---------------------------------------------------------------------------------- |
| `SF_RUNTIME=cloud`                  | Enables hosted defaults.                                                           |
| `SF_FACTORY_DIR=/var/data/.factory` | Keeps the ledger and token state on the persistent disk.                           |
| `SF_OPERATOR_TOKEN`                 | Stable secret for CLI and skill mutations. The blueprint generates one.            |
| `SF_PUBLIC_BASE_URL`                | Optional but recommended hosted URL, e.g. `https://software-factory.onrender.com`. |

## Cloud Setup Diagnostics

`GET /api/setup` (also exposed as the `software_factory_get_setup` MCP tool)
reports what a hosted instance still needs before runs can execute, package,
and deploy. The THREE credential surfaces stay separate (hardening E5), and
every credential is reported by PRESENCE only — secret values never appear in
the response or in ledger evidence:

| Section                                          | Surface                                                       | Setup env                                          |
| ------------------------------------------------ | ------------------------------------------------------------- | -------------------------------------------------- |
| `workspace.materialization.checkoutCredentials`  | Source checkout (private GitHub repo materialization)         | `SF_GIT_CHECKOUT_TOKEN`                            |
| `deploy`                                         | Deploy provider (`status` + named `missing` pieces)           | `SF_RENDER_API_KEY`, `SF_RENDER_SERVICE_ID`, `SF_RENDER_HOSTED_URL`, `SF_DEPLOY_GITHUB_OWNER/REPO` |
| `research.searchCredentials`                     | Research web-search provider                                  | `SF_RESEARCH_SEARCH_PROVIDER`, `SF_RESEARCH_SEARCH_API_KEY` |
| `storage`                                        | Persistent JSONL ledger (single-instance)                     | `SF_FACTORY_DIR` on a mounted persistent disk      |

`storage.status` is `attention` on a cloud instance that has not set
`SF_FACTORY_DIR` explicitly: without a persistent disk the ledger (and a
file-backed operator token) disappears on redeploy. Missing deploy or research
setup never blocks local execution — the affected stage pauses with a
setup-required state instead.

## Calling The Cloud Factory

After deploy, copy the hosted `SF_OPERATOR_TOKEN` from the provider dashboard
into your local shell. Then point the CLI or installed skills at the hosted URL:

```powershell
$env:SF_BASE_URL = 'https://your-factory.onrender.com'
$env:SF_OPERATOR_TOKEN = '<hosted SF_OPERATOR_TOKEN>'
software-factory run "Build an AI services marketplace" --json
```

The Codex and Claude wrappers use the same variables. Remote URLs are probed
only; the wrappers do not try to spawn a local backend when `SF_BASE_URL` points
at a cloud host.

## Calling From ChatGPT.com

ChatGPT.com web usage has two supported shapes.

### Custom GPT Action

Use `integrations/chatgpt/actions.openai.yaml` as a GPT Action schema.

1. Replace `https://YOUR_FACTORY_HOST` with the deployed factory URL.
2. Configure API key authentication.
3. Use header name `x-operator-token`.
4. Use the hosted `SF_OPERATOR_TOKEN` as the key value.

The action covers the full lifecycle: create/list/inspect runs, read events,
trigger and read research, start/pause/resume/retry execution, re-run gates,
read execution state, list and resolve interventions, read run outputs, and
cancel a run. The schema is validated as a real OpenAPI 3.1 document by
`packages/web/test/server/chatgpt-action-schema.test.ts`.

### Hosted MCP

ChatGPT/App-style integrations that support remote MCP can call the same hosted
bridge as Claude:

```text
https://your-factory.onrender.com/mcp
```

Tool calls require `Authorization: Bearer <SF_OPERATOR_TOKEN>` or
`x-operator-token: <SF_OPERATOR_TOKEN>`. If the integration requires OAuth, put
an OAuth/auth proxy in front of `/mcp` (see "OAuth / Auth-Proxy Compatibility"
below).

See `integrations/chatgpt/remote-mcp.md`.

## Calling From Claude.com

Use the hosted MCP bridge as a custom connector:

```text
https://your-factory.onrender.com/mcp
```

Tool calls require `Authorization: Bearer <SF_OPERATOR_TOKEN>` or
`x-operator-token: <SF_OPERATOR_TOKEN>`. If your connector setup cannot attach a
static Bearer token, put an OAuth/auth proxy in front of `/mcp` (next section).

See `integrations/claude/remote-mcp.md`.

## OAuth / Auth-Proxy Compatibility

Some hosted platforms cannot attach a static bearer/API-key header and only
support OAuth for remote connectors. The factory deliberately keeps its own
auth model simple (one operator token); OAuth compatibility is provided by a
small proxy in front of `/mcp` rather than inside the factory:

```text
Claude.com / ChatGPT.com ── OAuth ──> auth proxy ── Bearer SF_OPERATOR_TOKEN ──> factory /mcp
```

Reference shape (any OAuth2-terminating reverse proxy works — oauth2-proxy, a
Cloudflare Worker/Access policy, or a ~50-line Node proxy):

1. The proxy terminates the platform's OAuth flow (authorization code +
   token endpoints, or the provider's marketplace app registration).
2. On each proxied request it validates the platform's access token, then
   REPLACES the inbound `Authorization` header with
   `Authorization: Bearer <SF_OPERATOR_TOKEN>` (or sets `x-operator-token`)
   before forwarding to the factory's `/mcp`.
3. The factory keeps enforcing its own operator-token check — the proxy is an
   additional gate, never a replacement, so a proxy misconfiguration fails
   closed instead of open.

Hardening notes:

- Store `SF_OPERATOR_TOKEN` only in the proxy's secret store; never mint it
  into OAuth client config or client-visible metadata.
- Restrict the proxy to `POST /mcp` (and optionally `GET /api/setup` for
  health); do not blanket-forward the operator UI.
- Rotate the operator token independently of the OAuth client secret; the
  proxy is the only place both exist.
- Log proxy auth failures separately from factory `security.command_rejected`
  events so platform-side auth problems are distinguishable from factory-side
  guard denials.

Until the first hosted smoke test demands it, this remains reference guidance:
Claude.com custom connectors and ChatGPT Actions both support static
header/API-key auth, which talks to `/mcp` and the HTTP API directly.

## Safety Notes

- Keep the hosted service private or behind platform auth if possible. The UI is
  an operator surface, not a public product.
- Rotate `SF_OPERATOR_TOKEN` after sharing logs or screen recordings that expose
  environment values.
- Use one instance. JSONL append ordering is process-local today.
- For multi-user or horizontally scaled cloud, replace the filesystem event
  store with Postgres/SQLite-over-volume plus advisory locking, then add a queue
  for worker execution.
