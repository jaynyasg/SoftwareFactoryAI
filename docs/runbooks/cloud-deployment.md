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

The action can create runs, list runs, inspect a run, read events, and cancel a
run.

### Hosted MCP

ChatGPT/App-style integrations that support remote MCP can call the same hosted
bridge as Claude:

```text
https://your-factory.onrender.com/mcp
```

Tool calls require `Authorization: Bearer <SF_OPERATOR_TOKEN>` or
`x-operator-token: <SF_OPERATOR_TOKEN>`. If the integration requires OAuth, put
an OAuth/auth proxy in front of `/mcp`.

See `integrations/chatgpt/remote-mcp.md`.

## Calling From Claude.com

Use the hosted MCP bridge as a custom connector:

```text
https://your-factory.onrender.com/mcp
```

Tool calls require `Authorization: Bearer <SF_OPERATOR_TOKEN>` or
`x-operator-token: <SF_OPERATOR_TOKEN>`. If your connector setup cannot attach a
static Bearer token, put an OAuth/auth proxy in front of `/mcp`.

See `integrations/claude/remote-mcp.md`.

## Safety Notes

- Keep the hosted service private or behind platform auth if possible. The UI is
  an operator surface, not a public product.
- Rotate `SF_OPERATOR_TOKEN` after sharing logs or screen recordings that expose
  environment values.
- Use one instance. JSONL append ordering is process-local today.
- For multi-user or horizontally scaled cloud, replace the filesystem event
  store with Postgres/SQLite-over-volume plus advisory locking, then add a queue
  for worker execution.
