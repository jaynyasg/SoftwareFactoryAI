/**
 * Research routes (full-factory U2).
 *
 *   POST /api/runs/:id/research (mutating, guarded) — trigger one bounded
 *        research pass for an existing run. Idempotent: when research already
 *        ran for the run (any status other than `none`) the existing projected
 *        state is returned instead of re-running, unless `force: true`.
 *   GET  /api/runs/:id/research (read-only) — the projected research view.
 *   GET  /api/knowledge         (read-only) — query the reusable knowledge
 *        index. Redacted/retired/retention-expired entries are never returned;
 *        stale entries require `includeStale=1` and are flagged; `sensitive`
 *        entries require the explicit `includeSensitive=1` opt-in (E4).
 *
 * The research trigger is the surface U3 wires into run creation; run-mode
 * changes themselves are out of U2 scope.
 */
import { projectKnowledgeIndex, projectResearch, queryKnowledge } from '@software-factory/core';
import type { KnowledgeEntryKind, KnowledgeQuery } from '@software-factory/core';
import type { ApiResponse, RouteContext, RouteDef } from '../app';
import { asRecord, num, str } from '../routes/parse';
import { guardRunCommand, notFound } from '../routes/shared';

const KNOWLEDGE_KINDS: readonly KnowledgeEntryKind[] = [
  'source',
  'finding',
  'repo_fact',
  'gate_lesson',
  'run_reference',
];

function knowledgeKinds(value: string | undefined): readonly KnowledgeEntryKind[] | undefined {
  if (value === undefined || value.length === 0) {
    return undefined;
  }
  const kinds = value
    .split(',')
    .map((part) => part.trim())
    .filter((part): part is KnowledgeEntryKind =>
      (KNOWLEDGE_KINDS as readonly string[]).includes(part),
    );
  return kinds.length > 0 ? kinds : undefined;
}

function csv(value: string | undefined): readonly string[] | undefined {
  if (value === undefined || value.length === 0) {
    return undefined;
  }
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return parts.length > 0 ? parts : undefined;
}

function flag(value: string | undefined): boolean {
  return value === '1' || value === 'true';
}

async function triggerResearch(ctx: RouteContext): Promise<ApiResponse> {
  const runId = ctx.params.id;
  const body = asRecord(ctx.request.body);
  const guarded = await guardRunCommand(ctx, runId, 'research.request');
  if (guarded.response !== null) {
    return guarded.response;
  }

  // Idempotent trigger: an already-researched run is returned, not re-run.
  const existing = projectResearch(guarded.events, runId);
  if (existing.status !== 'none' && body.force !== true) {
    return {
      status: 200,
      body: { runId, alreadyResearched: true, research: existing },
    };
  }

  const budgetBody = asRecord(body.budget);
  const result = await ctx.runResearch(runId, {
    objective: str(body.objective),
    budget: {
      maxSources: num(budgetBody.maxSources),
      maxDurationMs: num(budgetBody.maxDurationMs),
    },
  });
  if (result === null) {
    return {
      status: 503,
      body: {
        error: 'research_disabled',
        message: 'Research is not enabled on this server instance.',
      },
    };
  }

  const research = projectResearch(await ctx.reader.readRun(runId), runId);
  return { status: 201, body: { runId, alreadyResearched: false, result, research } };
}

async function getResearch(ctx: RouteContext): Promise<ApiResponse> {
  const runId = ctx.params.id;
  const events = await ctx.reader.readRun(runId);
  if (events.length === 0) {
    return notFound(runId);
  }
  return { status: 200, body: { runId, research: projectResearch(events, runId) } };
}

async function queryKnowledgeIndex(ctx: RouteContext): Promise<ApiResponse> {
  const query = ctx.request.query;
  const runId = query.runId;
  const events =
    runId !== undefined && runId.length > 0
      ? await ctx.reader.readRun(runId)
      : await ctx.reader.readAll();
  const index = projectKnowledgeIndex(
    events,
    runId !== undefined && runId.length > 0 ? { runId } : {},
  );

  const now = ctx.clock();
  const knowledgeQuery: KnowledgeQuery = {
    now,
    kinds: knowledgeKinds(query.kinds),
    tags: csv(query.tags),
    text: str(query.text),
    minConfidence: num(Number(query.minConfidence)) ?? undefined,
    includeStale: flag(query.includeStale),
    includeSensitive: flag(query.includeSensitive),
    limit: num(Number(query.limit)) ?? undefined,
  };
  const matches = queryKnowledge(index, knowledgeQuery);
  return {
    status: 200,
    body: {
      now,
      count: matches.length,
      matches: matches.map((match) => ({
        stale: match.stale,
        ageMs: match.ageMs,
        entry: match.entry,
      })),
    },
  };
}

export function researchRoutes(): RouteDef[] {
  return [
    { method: 'POST', pattern: '/api/runs/:id/research', handler: triggerResearch },
    { method: 'GET', pattern: '/api/runs/:id/research', handler: getResearch },
    { method: 'GET', pattern: '/api/knowledge', handler: queryKnowledgeIndex },
  ];
}
