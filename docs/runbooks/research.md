# Research Stage Runbook

How the Software Factory's bounded, source-backed research stage works, how to
configure its sources and budgets, and how to recover when it reports gaps or
setup requirements.

## What research is (and is not)

Research runs before planning (and optionally during execution) to ground the
build brief in real evidence. It is:

- **ledger-first** — every step is a `research.*` event replayed by
  `projectResearch`; there is no research state outside the ledger,
- **bounded** — budgets cap sources, elapsed time, and source classes; a
  tripped budget records an explicit gap rather than silently truncating,
- **fail-closed** — a source class that is not allowed, not configured, or
  missing credentials is recorded as a setup requirement / gap. The runner
  never fabricates findings for sources it could not read.

Output is classified per the U1 event model:

| Classification | Event                          | Meaning                                                   |
| -------------- | ------------------------------ | --------------------------------------------------------- |
| verified fact  | `research.finding_recorded`    | Backed by a read source (`classification: verified_fact`) |
| inference      | `research.finding_recorded`    | Derived, not directly source-verified                     |
| assumption     | `research.assumption_recorded` | Working premise adopted without verification              |
| unresolved gap | `research.gap_recorded`        | Open question research could not answer                   |

Gaps are resolved by later findings via `resolvesGapId` — there is no separate
gap-resolved event.

## Source classes and adapters

| Source class    | Adapter                      | Network | Credentials | Notes                                                                                                                                                                     |
| --------------- | ---------------------------- | ------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `local_folder`  | `createRepoScanAdapter`      | no      | no          | Local runtime only; scans stay inside the approved workspace root — `..` traversal and absolute escapes are rejected. Cloud runs record the folder as unavailable (KTD5). |
| `repo_scan`     | `createRepoScanAdapter`      | no      | no          | GitHub repos surface as setup-required until workspace materialization (U4) provides a checkout.                                                                          |
| `uploaded_prd`  | `createPrdAdapter`           | no      | no          | Uploaded PRD text is digested + heading-mined. A `prdRef` without content records a gap instead of pretending the file was read.                                          |
| `documentation` | `createDocumentationAdapter` | yes     | no          | Operator-configured URLs only (`SF_RESEARCH_DOC_URLS`).                                                                                                                   |
| `web_search`    | `createWebSearchAdapter`     | yes     | yes         | Provider hook only in U2 — with no provider configured, research records a setup requirement + gap.                                                                       |

## Configuration (environment)

| Variable                      | Default | Meaning                                                                                                     |
| ----------------------------- | ------- | ----------------------------------------------------------------------------------------------------------- |
| `SF_RESEARCH_ALLOW_NETWORK`   | off     | Allow network source classes (`documentation`, `web_search`). Fail-closed by default.                       |
| `SF_RESEARCH_DOC_URLS`        | (none)  | Comma-separated documentation URLs research may fetch.                                                      |
| `SF_RESEARCH_SEARCH_PROVIDER` | (none)  | External web-search provider id.                                                                            |
| `SF_RESEARCH_SEARCH_API_KEY`  | (none)  | Web-search provider credential. Only its **presence** is ever reported; the value never reaches the ledger. |
| `SF_RESEARCH_MAX_SOURCES`     | 12      | Default max sources read per pass.                                                                          |
| `SF_RESEARCH_MAX_DURATION_MS` | 120000  | Default max elapsed ms per pass.                                                                            |

Research provider credentials are a separate setup surface from source-checkout
credentials and deploy credentials (hardening E5). Never reuse one secret for
another surface.

## Budgets

Budgets are enforced BEFORE each source read:

- `maxSources` — total sources per pass,
- `maxDurationMs` — elapsed wall clock per pass,
- `maxSourcesPerKind` — per-source-class caps (runner option).

When a budget rule trips, remaining sources are skipped and a
`research.gap_recorded` event states which rule tripped and that the brief is
based on a bounded subset. Raise the budget and re-run research if more
evidence is needed.

## Source policy

Policy is applied before any fetch or index write:

1. **Allowed classes** — a class not in `allowedKinds` is skipped with a gap.
2. **Network gating** — `documentation`/`web_search` additionally require
   `allowNetwork`.
3. **Credentials** — adapters that require credentials are refused (fail
   closed) when they are absent: an `adapter.setup_required` event plus a gap.
4. **Redaction** — all summaries/statements/bodies pass through
   `redactSecrets` so secret-shaped values (key/token/password assignments,
   bearer tokens, known credential prefixes) never become ledger evidence or
   knowledge-index content.

## Knowledge index

Reusable findings are normalized into `knowledge.entry_recorded` entries with
required `confidence` and `sensitivity`, a freshness horizon (`freshUntil`,
default 30 days), `sourceRunId`, and the evidencing finding event id. Later
passes seed prior knowledge into the brief WITHOUT hiding provenance: each
seeded finding carries the entry's recorded time, age, staleness flag, and
confidence.

Query rules (E4): redacted/retired/retention-expired entries are never
returned; `sensitive` entries require `includeSensitive`; stale entries require
`includeStale` and are flagged.

## HTTP surface

- `POST /api/runs/:id/research` (guarded) — trigger one bounded pass.
  Body: `{ objective?, budget?: { maxSources?, maxDurationMs? }, force?, expectedVersion? }`.
  Idempotent: an already-researched run returns its existing projection unless
  `force: true`.
- `GET /api/runs/:id/research` — the projected research view.
- `GET /api/knowledge` — query the knowledge index
  (`text`, `tags`, `kinds`, `minConfidence`, `includeStale=1`,
  `includeSensitive=1`, `limit`, `runId`).

## Troubleshooting

| Symptom                                          | Cause                                                                 | Fix                                                                                                                               |
| ------------------------------------------------ | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Gap: "requires setup ... web-search provider"    | No `SF_RESEARCH_SEARCH_PROVIDER`/credentials                          | Configure the provider + credential env vars, then re-run research with `force: true`. This is fail-closed behavior, not a fault. |
| Gap: "not allowed by the research source policy" | Network class requested with `SF_RESEARCH_ALLOW_NETWORK` off          | Enable network research explicitly if the deployment permits it.                                                                  |
| Gap: "escapes the approved workspace boundary"   | Run's local folder (or a locator) resolved outside the workspace root | Choose a folder inside the approved boundary; traversal is rejected by design.                                                    |
| Gap: "Research budget exhausted"                 | Source/time/class budget tripped                                      | Raise `SF_RESEARCH_MAX_SOURCES` / `SF_RESEARCH_MAX_DURATION_MS` (or the request budget) and re-run.                               |
| `research.failed`                                | Runner-level error or cancellation                                    | Partial sources/findings/gaps stay replayable. See `docs/runbooks/failure-taxonomy.md#researchfailed`.                            |
| Local folder gap on a cloud instance             | Cloud runs cannot read laptop paths (KTD5)                            | Provide a GitHub repository or upload the PRD content.                                                                            |
