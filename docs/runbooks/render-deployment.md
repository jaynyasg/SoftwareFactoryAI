# Runbook: Render Deployment

How the Software Factory promotes a generated app to a hosted Render deployment
after local completion. Hosting is **local-first**: a deploy is only attempted
once local gates, preview health, packaging, provenance, and review policy are
satisfied (plan unit U9, requirements R9–R11, R13, R14).

To deploy the factory control room itself to the cloud, use
`docs/runbooks/cloud-deployment.md` and the root `render.yaml`.

## Order of operations

```
local gates pass -> preview healthy -> package repo + provenance -> review satisfied
  -> resolve Git destination -> generate + validate render.yaml
  -> trigger Render deploy -> poll status -> hosted health check -> hosted URL
```

The hosted URL is shown **only** after the provider reports the deploy live
**and** a hosted health check passes (`deploy.hosted_ready`). Every earlier phase
emits its own ledger event and never a URL.

## 1. GitHub setup (configured first)

Render deploys from a connected Git repository. The factory resolves the Git
destination in this order:

1. **User-provided GitHub destination (preferred).** Provide `owner` + `repo`
   (and optionally a remote URL / default branch). The packaged repo is pushed
   here and Render deploys from it.
2. **Factory-owned temporary repo (fallback).** When no user destination is
   given and temporary fallback is permitted, the factory uses a repo named
   `sf-temp-<runId>` under the `software-factory` owner and **marks ownership as
   temporary** in the descriptor, in `PROVENANCE.json` (`gitDestination.temporary`
   = `true`), and in the Factory Floor UI.
3. **Setup required.** When neither is configured and temporary fallback is not
   permitted, the deploy **pauses** with `deploy.setup_required` and a setup
   action. The local run is **not** marked failed — packaging and provenance are
   already complete; only the hosted step is deferred until setup is done.

### Factory-owned temporary repo: behavior + cleanup

- The temporary repo is a **convenience**, not a home for the user's code. Treat
  it as disposable.
- Provenance records a `cleanupNote`. After a successful handoff, either:
  - transfer/fork the repo to the user's own GitHub account, or
  - delete it once the user has migrated, or after the retention window.
- Real GitHub repo **creation** via the API for the temporary fallback is
  **deferred** (see TODOS). The default `GitRemoteClient` reports `created: false`
  with a note rather than pretending it created a repo; wire a credentialed
  GitHub client (or `gh repo create`) to enable automatic creation.

## 2. Render setup

| Requirement       | Notes                                                                             |
| ----------------- | --------------------------------------------------------------------------------- |
| Render account    | https://render.com                                                                |
| Render API key    | Account Settings -> API Keys. Provide as `RENDER_API_KEY`.                        |
| Service id        | The target web service id (`srv-…`). Created from the blueprint or the dashboard. |
| Postgres database | Provisioned by the blueprint (`databases:`), wired into `DATABASE_URL`.           |

If the API key or service id is missing, the deploy pauses with
`deploy.setup_required` (Render not configured) — again **without** failing the
local run.

## 3. Generated `render.yaml` (Blueprint)

`render-config.ts` generates **and validates** the blueprint so it matches the
generated app (prisma migrate + `next build`, `next start`, `/api/status` health,
a Postgres database wired into `DATABASE_URL`). A representative blueprint:

```yaml
services:
  - type: web
    name: ai-services-marketplace
    env: node
    plan: starter
    buildCommand: pnpm install && pnpm exec prisma generate && pnpm exec prisma migrate deploy && pnpm build
    startCommand: pnpm start
    healthCheckPath: /api/status
    envVars:
      - key: DATABASE_URL
        fromDatabase:
          name: ai-services-marketplace-db
          property: connectionString
      - key: NODE_ENV
        value: production
      - key: AI_BRIEF_PROVIDER
        sync: false
      - key: AI_BRIEF_API_KEY
        sync: false
databases:
  - name: ai-services-marketplace-db
    databaseName: ai_services_marketplace_db
    user: ai_services_marketplace_user
    plan: starter
```

Validation catches missing **build**, **start**, **migration**, **env**
(`DATABASE_URL`), and **health** fields and returns structured errors; the
deployer turns the first into `deploy.config_invalid`.

> The generated app ships with a **SQLite** datasource for local/test. The hosted
> profile is **Postgres**: switch the Prisma datasource `provider` to
> `postgresql` and generate a Postgres migration history (`prisma migrate dev
--name init`) so `prisma migrate deploy` has migrations to apply on Render.

## Environment variables

| Variable            | Where                  | Purpose                                                                  |
| ------------------- | ---------------------- | ------------------------------------------------------------------------ |
| `DATABASE_URL`      | Render (from database) | Prisma datasource (Postgres connection string).                          |
| `RENDER_API_KEY`    | Factory operator env   | Authenticates the Render API client.                                     |
| `AI_BRIEF_PROVIDER` | Render (optional)      | Selects a live AI brief provider; unset uses the deterministic fallback. |
| `AI_BRIEF_API_KEY`  | Render (optional)      | API key for the live brief provider.                                     |
| `NODE_ENV`          | Render                 | `production`.                                                            |

Host secrets are never passed into sandboxed generated-app commands; only the
explicit deploy env is sent to Render.

## Deploy events + failure taxonomy

| Event                     | Meaning                                                               | Retry            |
| ------------------------- | --------------------------------------------------------------------- | ---------------- |
| `deploy.setup_required`   | Preconditions/GitHub/Render setup incomplete — paused.                | Yes, after setup |
| `deploy.config_invalid`   | Generated `render.yaml` failed validation.                            | Yes, after fix   |
| `deploy.provider_failed`  | Render build/deploy failed (or timed out, or could not be triggered). | Yes              |
| `deploy.migration_failed` | `prisma migrate deploy` failed during the build.                      | Yes              |
| `deploy.health_pending`   | Provider reported the deploy live; hosted health is being checked.    | —                |
| `deploy.health_failed`    | Hosted health never passed within the budget.                         | Yes              |
| `deploy.hosted_ready`     | Provider success **and** hosted health passed — hosted URL emitted.   | —                |

Provider failure, deploy timeout, migration failure, and health failure attach
the deploy log lines as event **evidence** and resolve to a **retryable**
outcome, so the operator can re-run the deploy after addressing the cause. A
deploy **timeout** surfaces as `deploy.provider_failed` (there is no dedicated
timeout event type) with a "did not reach a terminal state" reason.

## Optional manual credentialed deploy

CI uses the **mocked** path (`tests/e2e/render-deploy-mocked.spec.ts`) and needs
no credentials. To run a real credentialed deploy manually:

1. Push the packaged repo to your GitHub destination (or connect the temporary
   repo).
2. In the generated app, switch the Prisma datasource to `postgresql` and create
   a migration history (`prisma migrate dev --name init`); commit it.
3. Create the Render Blueprint/service (dashboard or `render.yaml`) and a Postgres
   database; note the service id.
4. Export `RENDER_API_KEY` for the factory operator process.
5. Trigger the deploy. Watch for `deploy.health_pending` then
   `deploy.hosted_ready{url}` on the ledger; the hosted URL appears only after
   hosted health passes.
6. **Clean up** afterward: if a factory-owned temporary repo was used, transfer
   or delete it; remove throwaway Render services/databases to avoid charges.

## Deferred (see TODOS.md)

- Automatic GitHub repo **creation** for the temporary fallback (needs a
  credentialed GitHub client / `gh`).
- Deeper Render API wiring (blueprint sync/create-service, log streaming).
- Non-Render deployment providers.
