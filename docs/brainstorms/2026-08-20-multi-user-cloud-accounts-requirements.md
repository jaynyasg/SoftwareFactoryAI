---
date: 2026-08-20
topic: multi-user-cloud-accounts
---

# Multi-User Cloud Accounts: Login, Credential Wizard, and Per-User Execution

## Summary

Add login-gated multi-user support to the cloud-deployed factory: invited people create accounts, onboard through a credential wizard (Claude plan token or API key, OpenAI API key or Codex plan login upload, GitHub token), and get a private per-user factory view. Their runs execute in the shared Render container billed to their own accounts. One admin account (the deploy owner) retains global visibility and control.

---

## Problem Frame

The deployed factory is single-tenant: one shared operator token authorizes every mutation, worker CLIs execute with credentials from the server environment, and anyone with access shares one identity, one credential set, and one bill. Sharing the deployment today means sharing the owner's Claude/OpenAI quota and exposing all activity to everyone. The only alternative — each person deploying their own Render instance — duplicates infrastructure, cost, and administration per person.

There is also a latent security cost to any sharing under the current design: worker processes inherit the full server environment, so a shared deployment would let any user's worker read the owner's GitHub token, operator token, and model keys.

---

## Actors

- A1. Admin (deploy owner): issues invites, sees and controls all runs and users, administers the deployment.
- A2. Invited user: redeems an invite, creates an account, provides their own credentials, runs private builds billed to their own accounts.
- A3. Worker processes: `claude`/`codex` CLI children executing tickets inside the shared container with per-run injected credentials.
- A4. Remote callers: the CLI, MCP connectors, and ChatGPT Actions, authenticating per user.

---

## Key Flows

- F1. Invite and account creation
  - **Trigger:** Admin generates an invite (link/code) for a specific person.
  - **Actors:** A1, A2
  - **Steps:** Admin issues invite → person opens link → sets username/password → lands in the credential wizard. A revoked or already-used invite fails with a clear message and creates nothing.
  - **Outcome:** The person has an account and a session; no credentials yet.
  - **Covered by:** R1, R2, R4

- F2. Credential onboarding wizard
  - **Trigger:** First login (and revisitable anytime from user settings).
  - **Actors:** A2
  - **Steps:** Wizard prompts for execution credentials — Claude plan token (with inline instructions to run `claude setup-token` locally) or Anthropic API key; OpenAI API key or Codex plan login file upload (`~/.codex/auth.json`); GitHub token (optional, marked required only for repo-source runs). Each credential is live-validated before acceptance; failures show actionable guidance.
  - **Outcome:** User's credentials stored encrypted; setup state visible as ready/missing per credential (presence only, values never redisplayed).
  - **Covered by:** R6, R7, R8, R9

- F3. Personalized run
  - **Trigger:** User starts a run from their factory view.
  - **Actors:** A2, A3
  - **Steps:** Run created with owner attribution → queued on the shared queue → workers spawn with an allowlisted environment containing only that user's credentials → run progresses under the owner's private view.
  - **Outcome:** Build executes on the user's own Claude/OpenAI/GitHub accounts; only the owner and admin can see or control it.
  - **Covered by:** R10, R12, R13, R16, R17

- F4. Admin oversight
  - **Trigger:** Admin opens the global views, or a user needs help.
  - **Actors:** A1
  - **Steps:** Admin sees all runs with owners, can control any run, can revoke a user (access and stored credentials), can re-invite a user who forgot their password (account and data preserved, password reset).
  - **Outcome:** One person can operate the deployment without touching server env for any user matter.
  - **Covered by:** R3, R4

- F5. Credential failure during a run (escape path)
  - **Trigger:** A run's credential is missing, invalid, or expires mid-run.
  - **Actors:** A2, A3
  - **Steps:** Run blocks with an intervention naming the owner and the concrete fix → user updates the credential in their settings → retry resumes the run.
  - **Outcome:** Credential problems are owner-visible and self-serviceable; never a silent failure, never an admin env change.
  - **Covered by:** R14

---

## Requirements

**Accounts and access**
- R1. Cloud mode gains a login screen; unauthenticated visitors can reach nothing except login and invite redemption. Local single-user mode is unchanged (no login).
- R2. Accounts are created only through admin-issued invites; invites are single-use and revocable.
- R3. Exactly one admin role in v1: the admin sees and can control everything; every other user sees and controls only their own runs, workspaces, credentials, and interventions.
- R4. Password reset is admin re-invite (no email infrastructure in v1); re-inviting an existing user resets access while preserving their account, runs, and credentials.
- R5. The CLI, MCP, and ChatGPT Action surfaces authenticate with per-user API tokens; the single shared operator token retires for cloud multi-user mode.

**Credential wizard**
- R6. The wizard collects: a Claude plan token (`CLAUDE_CODE_OAUTH_TOKEN`) or Anthropic API key; an OpenAI API key or a Codex plan login file upload; a GitHub token (optional — required only for GitHub-source runs).
- R7. Each credential is validated with a live probe before acceptance; failures show actionable guidance, including how to mint a Claude plan token (`claude setup-token`).
- R8. Users can replace or remove their credentials at any time; values are never displayed back after entry (presence/status only).
- R9. Credentials are stored encrypted at rest on the persistent disk with a server-side key, surviving deploys and restarts so interrupted runs can resume.

**Execution and isolation**
- R10. Worker spawn environments become allowlist-based for ALL runs: a worker receives only the owning user's credentials plus process essentials — no server-level secrets, no other user's secrets, ever.
- R11. The admin's own runs use the same per-user credential rails; server-level model and GitHub keys are no longer used for execution in cloud mode.
- R12. Codex plan users execute through a per-user Codex home carrying their uploaded login; refreshed tokens are persisted back to that user's store.
- R13. GitHub-source runs check out and publish with the owning user's GitHub token.
- R14. When a run's credential is missing, invalid, or expires mid-run, the run blocks with an intervention directed at the owner naming the fix; updating the credential and retrying resumes the run.
- R15. Queue fairness: one user's long usage-limit wait must not monopolize worker capacity for other users' queued runs (mechanism chosen in planning).

**Visibility and attribution**
- R16. All read and control surfaces — factory floor, run pages, events, operator dashboard, MCP/Action tools — are scoped to the authenticated user; the admin gets global equivalents.
- R17. Every run carries durable owner attribution in the ledger.

---

## Acceptance Examples

- AE1. **Covers R10.** Given user B's run, when a worker is instructed to print its environment, the output contains only B's own credentials and process basics — never the admin's, the server's, or another user's secrets.
- AE2. **Covers R14.** Given user B's Claude token expires mid-run, the run blocks with an intervention naming B and the fix; after B replaces the token in settings and retries, the run resumes without admin involvement.
- AE3. **Covers R2, R4.** Given a revoked invite link, opening it fails clearly and creates no account. Given B forgot their password, an admin re-invite restores access with B's runs and credentials intact.
- AE4. **Covers R3, R16.** Given users B and C each have runs, B's factory view lists only B's runs; the admin's view lists all runs with owner labels.
- AE5. **Covers R15.** Given user B's run is sleeping on a usage-limit reset, user C's queued run still starts while B waits.

---

## Success Criteria

- An invited person goes from invite link → account → pasted credentials → first run executing on their own accounts, with zero admin action beyond sending the invite.
- The Render service environment contains no model or GitHub credentials used for execution — proven by AE1-style env inspection.
- Two users run concurrently, each billed to their own accounts, neither able to see the other's runs through any surface.
- Planning can proceed without inventing product behavior: roles, flows, credential handling, and failure paths are specified here.

---

## Scope Boundaries

- No self-serve signup, billing, quotas, or abuse prevention — that is the deferred P2/P3 hosted-SaaS work (TODOS.md).
- No OS-level isolation between users: one container, one filesystem; users are protected from each other by app-layer scoping and CLI tool policy, not walls. Per-user sandboxing is deferred.
- No email infrastructure (hence re-invite as password reset).
- No local worker agent (cloud app dispatching to a user's local machine) — the only route to "picks up my local claude automatically"; deferred.
- No teams, organizations, or multiple admin accounts.
- No horizontal scaling changes; the single-instance ledger/queue seam stays as documented in ARCHITECTURE.md.

---

## Key Decisions

- Private per-user views with one admin (revised from a shared-floor v1 during dialogue): privacy between users is worth roughly 2–3× the build cost; the credential rails are identical either way, so the earlier shared-floor option was a strict subset.
- Credentials encrypted at rest rather than memory-only: users paste once and interrupted runs resume across deploys. This deliberately revises the repo's "secrets live only in the environment" invariant (E5) for user credentials, with encryption as the compensating control.
- Codex plan login upload included in v1: full parity with local plan-billed usage, accepting file-upload and token-refresh fragility over an API-key-only simplification.
- Env allowlist for every worker spawn: closes the server-secret exposure and is a hard prerequisite for any sharing; applies to the admin's runs too.
- Same-container trust model for v1: invite-only keeps co-tenants mutually trusted; hard isolation is explicitly out of scope.

---

## Dependencies / Assumptions

- Depends on the cloud Docker image with baked-in worker CLIs (built and runtime-validated 2026-08-20).
- Assumes the container `claude` CLI honors `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` from a per-spawn environment (probe machinery verified; exact CLI behavior is a first-deploy check already noted in the cloud runbook).
- Assumed demand: no specific first users were named during the brainstorm. Treat the first one or two invites as validation before layering more (e.g., accounts UI polish, more credential types).
- The append-only JSONL ledger cannot hold mutable account/credential records; where accounts live is a planning decision.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R15][Technical] Fairness mechanism: per-user worker caps, yielding slots during usage-limit sleeps, or run-level preemption.
- [Affects R12][Technical] How Codex login refresh writes are synchronized and persisted per user without cross-run races.
- [Affects R9][Technical] Encryption scheme and key handling for at-rest credentials (key in env; rotation story).
- [Affects R5][Technical] How per-user API tokens integrate with the existing command guard, CSRF flow, and the static-token MCP/Action connectors.
- [Affects R1, R16][Technical] Where account records and sessions live given the append-only event store (sidecar store vs new tables behind the existing storage seam).
