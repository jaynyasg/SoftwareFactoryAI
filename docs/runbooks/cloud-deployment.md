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

Horizontal scaling is UNSAFE with this build: do not run more than one
instance (or more than one execution daemon) against the same JSONL ledger.
See "Scaling Limits And The Migration Seam" below.

## Render Deployment

The root `render.yaml` deploys the factory itself as a **Docker** service
(`runtime: docker`, root `Dockerfile`). The image is what makes cloud
EXECUTION possible: a plain Node build serves the UI and plans runs, but no
worker CLI exists on the host, so every ticket would fail preflight with
`adapter.setup_required`. The Dockerfile therefore:

- installs the `claude` (Claude Code) and `codex` worker CLIs globally,
- installs the vendored worker skills (`skills/worker/*`) into the runtime
  user's `~/.claude/skills` + `~/.codex/skills` via
  `node scripts/install-worker-skills.mjs`,
- runs as a non-root `factory` user whose HOME carries CLI credentials/skills,
- boots through `scripts/docker-entrypoint.sh`, which logs adapter auth state
  and performs the one-time `codex login` from `OPENAI_API_KEY`.

Health checks hit `/api/setup`, which now includes REAL adapter detection
(cached + non-blocking), so the Factory Floor setup checklist on a hosted
instance honestly reports whether `claude`/`codex` are installed and
authenticated.

## Worker CLI Auth (Cloud Execution)

Workers execute through the CLIs' own auth. Headless options:

| CLI      | Env var                  | Notes                                                                                                     |
| -------- | ------------------------ | --------------------------------------------------------------------------------------------------------- |
| `claude` | `ANTHROPIC_API_KEY`      | API-billed. Passed through the nested-session scrub by design.                                            |
| `claude` | `CLAUDE_CODE_OAUTH_TOKEN` | Plan-billed. Mint once with `claude setup-token` on any machine; the scrub explicitly preserves this key. |
| `codex`  | `OPENAI_API_KEY`         | The entrypoint converts it to a stored `codex login` at boot (tries `--api-key`, then `--with-api-key`).  |

Set whichever you use as Render env vars (the blueprint declares them with
`sync: false`). The entrypoint logs a clear line per CLI at boot; the setup
checklist shows the probed result. First-deploy validation worth doing once:
confirm the boot log shows the ledger dir writable (`/var/data/.factory`) by
the non-root user, and that `claude auth status` reports the env credential —
if it does not on the installed CLI version, prefer the
`CLAUDE_CODE_OAUTH_TOKEN` path.

The table above is the SINGLE-TENANT story. With multi-user mode on (next
section), leave every server-level model key unset: runs execute on each
OWNER's credentials from the encrypted vault instead.

## Multi-User Mode (Accounts + Per-User Credentials)

`SF_MULTI_USER=1` turns the hosted factory into an invited-accounts service:
users sign in at `/login`, add THEIR OWN credentials in the wizard
(`/onboarding`, later `/settings`), and every run executes on its owner's
Claude/Codex/GitHub accounts. The admin sees every run with owner labels;
users see only their own.

### Fresh multi-user deploy (zero server-level model keys)

1. Set in the Render dashboard (all `sync: false` in the blueprint):
   - `SF_MULTI_USER=1`
   - `SF_MASTER_KEY` — generate:
     `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`.
     PLATFORM SECRET STORE ONLY: never commit it, never write it to a file
     under the factory dir (a key file next to the encrypted vault defeats
     encryption at rest; boot warns if it finds one).
   - `SF_BOOTSTRAP_INVITE` — high entropy (`openssl rand -base64 24`).
   - Leave `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` / `OPENAI_API_KEY`
     UNSET.
   Boot fails closed with an exact remediation message when the key is
   missing/invalid, the bootstrap invite is low-entropy, or no browser origin
   is configured (Render's `RENDER_EXTERNAL_URL` satisfies the origin
   requirement automatically).
2. Deploy, then open `https://<url>/invite/<SF_BOOTSTRAP_INVITE>` and create
   the FIRST ADMIN account (the bootstrap is consume-once; remove the env var
   afterwards if you like — it can never create a second admin).
3. You land in the credential wizard: paste your Claude OAuth token
   (`claude setup-token`) or API key, upload your codex `auth.json`, add a
   fine-grained GitHub PAT, optionally Render/Vercel deploy tokens. Every
   value is validated live, stored encrypted, and shown as presence-only ever
   after.
4. Admin panel (`/admin`): issue invite links for your users. Each invitee
   picks a username/password, lands in the same wizard, and their runs bill
   THEIR accounts.
5. Start a run — the walkthrough is done with zero server-env model keys.

### Migrating an existing single-tenant deployment

Set the three env vars above and redeploy. What changes, honestly:

- The shared `SF_OPERATOR_TOKEN` is REFUSED with a 401 carrying migration
  guidance ("mint a personal API token under Settings"); update CLI/MCP/Action
  callers to personal `sfai_` tokens (`SF_API_TOKEN` for the CLI — same header
  slot, nothing else changes).
- Existing runs have no owner and become ADMIN-OWNED: visible to the admin
  only, and NOT executable (no owner credentials exist for them). Queued
  legacy work blocks with an admin-directed intervention instead of running
  on a guessed account; re-create runs you still need from an account.
- Turning the flag OFF later does NOT downgrade: initialized auth stores on
  disk keep multi-user enforcement on (fail closed) and the boot log says so.
  Genuinely returning to single-tenant requires deleting
  `<factoryDir>/auth/` (and `<factoryDir>/credentials/`) deliberately.

### Break-glass: locked-out admin

Set `SF_BOOTSTRAP_REARM=1` alongside the existing `SF_BOOTSTRAP_INVITE` and
redeploy; the invite URL can now RESET the admin password once (existing admin
sessions and API tokens are invalidated). Unset the re-arm flag afterwards.

### Master-key rotation / loss

The vault decrypts with exactly the key it was written under. A wrong or
missing key does NOT crash the service: logins and every non-credential
surface keep working, credential reads/writes answer a typed
`master_key_unreadable`, and runs block with an ADMIN-directed intervention
naming the fix. Restore the correct `SF_MASTER_KEY` and redeploy; if the key
is truly lost, users re-enter their credentials in the wizard (values are
never recoverable by design).

## Worker Skills In The Cloud

Skills are a machine-level convention (`~/.claude/skills`, `~/.codex/skills`),
so the image vendors them from `skills/worker/` (see its README). Claude skill
access stays fail-closed: the blueprint grants exactly
`SF_CLAUDE_ALLOWED_SKILLS=software-factory-conventions`. Add names (never `*`
in cloud) as you vendor more skills. All entry points — the Next mount AND the
standalone/hosted server — resolve these env knobs through the shared
`adapter-env` module.

It also mounts a persistent disk at `/var/data` and stores the factory ledger in
`/var/data/.factory`.

## Execution Drain Gate

Every server process boots with execution HELD: LEFTOVER queued work (enqueued
before the process started) does not run until an operator clicks
**Resume execution** on the Factory Floor (or calls
`POST /api/execution/resume`). The gate is process-local BY DESIGN — every
deploy or restart re-holds. The DECIDED hosted policy is held-by-default: after
every deploy/restart an operator must open the web UI and resume. This is
intentional safety-first behavior, so a fresh (or crashed-and-restarted) cloud
instance never drains queued runs unattended.

The gate does NOT apply to runs the operator explicitly starts after boot:
"Start run" (mode `plan-and-start`), `POST /api/runs/:id/start`, and
`POST /api/runs/:id/retry` each grant that one run a gate bypass, so a single
attended action carries a run straight to executing workers. An explicit
`POST /api/execution/hold` revokes all grants issued so far.

- `GET /api/execution` reports
  `{execution: {enabled, held, running}, queue: {queued, leased}}`.
- `POST /api/runs/cancel-all` cancels every cancellable run if you need to
  drain the queue instead of resuming it.
- Set `SF_EXEC_AUTOSTART=1` (also accepts `true`/`yes`; anything else means
  held) to opt a deployment back into unattended drain-on-start. The shipped
  `render.yaml` keeps it commented out.

Required env:

| Key                                 | Purpose                                                                            |
| ----------------------------------- | ---------------------------------------------------------------------------------- |
| `SF_RUNTIME=cloud`                  | Enables hosted defaults.                                                           |
| `SF_FACTORY_DIR=/var/data/.factory` | Keeps the ledger and token state on the persistent disk.                           |
| `SF_OPERATOR_TOKEN`                 | Stable secret for CLI and skill mutations. The blueprint generates one.            |
| `SF_PUBLIC_BASE_URL`                | Optional but recommended hosted URL, e.g. `https://software-factory.onrender.com`. |
| `SF_EXEC_AUTOSTART`                 | Optional. Unset (default) boots execution HELD; `1`/`true`/`yes` opts into drain-on-start. |
| `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` | Claude worker CLI auth (see "Worker CLI Auth").                        |
| `OPENAI_API_KEY`                    | Codex worker CLI auth — logged in by the entrypoint at boot.                       |
| `SF_WORKSPACE_CHECKOUT_ROOT`        | Where GitHub-source checkouts materialize (`/var/data/checkouts` on the disk).     |
| `SF_CLAUDE_ALLOWED_SKILLS`          | Fail-closed grant of installed skills to Claude workers (names, never `*` in cloud). |
| `SF_PREFERRED_SKILLS`               | Skill names workers are steered toward (both CLI families).                        |

## Cloud Setup Diagnostics

`GET /api/setup` (also exposed as the `software_factory_get_setup` MCP tool)
reports what a hosted instance still needs before runs can execute, package,
and deploy. The THREE credential surfaces stay separate (hardening E5), and
every credential is reported by PRESENCE only — secret values never appear in
the response or in ledger evidence:

| Section                                         | Surface                                                | Setup env                                                                                          |
| ----------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `workspace.materialization.checkoutCredentials` | Source checkout (private GitHub repo materialization)  | `SF_GIT_CHECKOUT_TOKEN`                                                                            |
| `deploy`                                        | Deploy provider (`status` + named `missing` pieces)    | `SF_RENDER_API_KEY`, `SF_RENDER_SERVICE_ID`, `SF_RENDER_HOSTED_URL`, `SF_DEPLOY_GITHUB_OWNER/REPO` |
| `research.searchCredentials`                    | Research web-search provider                           | `SF_RESEARCH_SEARCH_PROVIDER`, `SF_RESEARCH_SEARCH_API_KEY`                                        |
| `storage`                                       | Persistent JSONL ledger (single-instance)              | `SF_FACTORY_DIR` on a mounted persistent disk                                                      |
| `queue`                                         | Execution queue mode + single-instance scaling warning | none — informational (see scaling section below)                                                   |
| `adapters`                                      | REAL worker-CLI detection (installed + authenticated)  | image + `ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN`/`OPENAI_API_KEY` (see "Worker CLI Auth")     |

`adapters.status` is `pending` on the first poll after boot (detection runs in
the background so the health check never blocks on CLI probes), then `ready`
with the authenticated adapter ids, or `attention` with a per-adapter reason
(`not installed` vs `not authenticated`).

`storage.status` is `attention` on a cloud instance that has not set
`SF_FACTORY_DIR` explicitly: without a persistent disk the ledger (and a
file-backed operator token) disappears on redeploy. Missing deploy or research
setup never blocks local execution — the affected stage pauses with a
setup-required state instead.

The `queue` section always reports `{ mode: "ledger", storage: "jsonl",
singleInstance: true, horizontalScaling: "unsafe" }` plus a warning naming the
migration seam. In cloud mode the server also logs one
`[software-factory] scale-safety:` warning line at startup with the same
information, so hosted logs record the limit for whoever operates the service
next.

## Scaling Limits And The Migration Seam

**When horizontal scaling is unsafe: always, with this build.** The factory
must run as exactly ONE instance with ONE execution daemon per ledger. Do not:

- set the instance/replica count above 1 (the shipped `render.yaml` pins
  `numInstances: 1` — keep it),
- enable autoscaling for the service,
- point two services (e.g. a web instance plus a "worker" instance) at the
  same `SF_FACTORY_DIR`, or
- run a local factory against a mounted copy of a cloud ledger while the cloud
  instance is live.

What breaks if you do: JSONL appends and per-run sequence allocation are
serialized inside one process, not across processes. A second writer can
interleave partial lines, duplicate sequence numbers, and bypass the
idempotency-key arbitration that keeps queue claims and command retries safe.
The failure is silent data corruption, not a clean error.

What IS safe today:

- one instance restarting (the ledger replays queued/leased/completed state;
  stale leases are abandoned and escalated to the intervention queue), and
- vertical scaling (a larger instance for the single process).

Scaling out requires the database-backed event store and durable queue behind
the documented seam — see ARCHITECTURE.md, "Hosted Scale Migration Seam", for
the stable interfaces (`EventStore`, queue event semantics, the daemon's
`TicketExecutor` seam), the invariants a replacement must preserve (append
atomicity, global idempotency, per-run sequence monotonicity, lease/heartbeat/
abandoned-lease recovery, reconcile-before-drain, pause fold immunity), and
the contract test suite (`packages/core/test/events/event-store-contract.ts`)
that any replacement backend must pass unchanged.

## Calling The Cloud Factory

After deploy, open the hosted Factory Floor and click **Resume execution** —
the daemon boots held (see "Execution Drain Gate" above), so anything you queue
before resuming just waits. Then copy the hosted `SF_OPERATOR_TOKEN` from the
provider dashboard into your local shell and point the CLI or installed skills
at the hosted URL:

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
`packages/web/test/server/chatgpt-action-schema.test.ts`. Drain-gate caveat: a
run started remotely only **queues** — it does not execute until execution is
resumed (see "Execution Drain Gate" above).

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
- Use one instance. JSONL append ordering is process-local today — see
  "Scaling Limits And The Migration Seam" above before changing instance
  counts.
- For multi-user or horizontally scaled cloud, implement the database-backed
  event store and durable queue behind the migration seam documented in
  ARCHITECTURE.md ("Hosted Scale Migration Seam") — the interfaces are stable
  and the contract tests already exist.
