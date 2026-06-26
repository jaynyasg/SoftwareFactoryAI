# TODOs

## P1: Existing-Repo Feature Insertion

**What:** Add a mode where the factory can apply a feature spec to an existing repository instead of only generating a greenfield app.

**Why:** The PRD and Athena case study both point at the harder enterprise problem: matching existing conventions across real products, not just generating new repos.

**Context:** Defer until V1 proves the local-first generated-repo loop: prompt/PRD intake, supervisor tickets, versioned genome, worker execution, replayable ledger, sandbox gates, review studio, provenance bundle, Render deploy, and generated AI Services Marketplace app.

**Effort:** XL human / L with CC+gstack.

**Depends on:** V1 generated-repo factory, lightweight codebase index, provenance bundle, and stable event ledger.

## P1/P2: Full Wetware Graph/Vector Intelligence

**What:** Build the full wetware-style intelligence layer: graph + vector codebase index, convention memory, provenance paths, context compilation, and pattern-aware retrieval for future existing-repo and multi-product generation.

**Why:** Lightweight generated-repo indexing is enough for V1, but the long-term product needs to learn real team conventions and retrieve the right context at generation time.

**Context:** Use `wetware-factory-main` as architecture fuel: knowledge-store, context-engine, agent-runtime, quality-gates, and boundary-control. Do not let this replace the Ash-first product runtime or block the first generated-app path.

**Effort:** XL human / L with CC+gstack.

**Depends on:** Stable ledger events, provenance bundle, generated-repo index, and enough completed runs to know which convention signals matter.

## P2: Non-Render Deploy Provider Adapters

**What:** Add deployment adapters for providers beyond Render, such as Vercel, Fly.io, Railway, AWS, or Kubernetes.

**Why:** Render is the V1 default because it gives one clear hosted path. Broader provider support matters once users bring their own deployment preferences.

**Context:** Do not generalize deployment before the Render adapter proves local completion -> Git destination -> hosted deploy -> hosted health check.

**Effort:** L human / M with CC+gstack.

**Depends on:** Render deployment adapter, deploy event taxonomy, Git destination handling, and hosted health checks.

## P2/P3: Production-Grade Hosted Factory Platform

**What:** Build the hosted SaaS version of the factory with multi-user auth, quotas, billing, sandbox fleet management, queue isolation, secrets handling, cleanup, audit controls, and abuse prevention.

**Why:** V1 is local-first, then Render deploy. A hosted platform becomes necessary once users need team access, managed workers, hosted sandboxes, and service-account execution.

**Context:** Do not start here. First prove the local factory loop and Render deployment path so hosted infrastructure serves a working product rather than becoming the product.

**Effort:** XL human / L with CC+gstack.

**Depends on:** Stable local runtime, execution adapter interface, sandbox policy, deploy adapter, operator observability, and real user demand for managed execution.

## P2: Human-Approved Genome Updates

**What:** Add a learning loop where repeated failures, review feedback, and recurring edits produce proposed updates to factory genome modules, prompts, contracts, tests, or dependency baselines.

**Why:** Ash SWF includes skill updates, and the factory should get better over time. The safe version proposes updates with evidence and requires human approval before activation.

**Context:** V1 uses manually versioned genome modules. Automatic mutation is intentionally deferred until ledger provenance, review studio actions, and gate evidence are trustworthy enough to explain why an update is proposed.

**Effort:** L human / M with CC+gstack.

**Depends on:** Versioned factory genome, replayable ledger, review studio, provenance bundle, and enough completed runs to detect repeated patterns.
