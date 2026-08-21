/**
 * ONE resolution of the adapter-catalog environment knobs, shared by every
 * place that constructs the default catalog (the Next-mounted singleton in
 * `instance.ts`, the hosted standalone server in `standalone.ts`, and the
 * app-level route-context default in `app.ts`). Before this module existed,
 * `standalone.ts` built its catalog with no options — silently dropping the
 * operator's `SF_CLAUDE_ALLOWED_SKILLS` grant on the exact entry point cloud
 * deployments use.
 */
import type { DefaultAdapterCatalogOptions } from '@software-factory/core';

/**
 * Parse `SF_CLAUDE_ALLOWED_SKILLS` — the opt-in list of Claude Code skills
 * factory workers may invoke (comma-separated names, or `*` for any). Unset =
 * NO skills (fail closed): the operator's machine can carry hundreds of
 * installed skills, including outward-facing deploy/publish ones, so worker
 * access to them is never implicit.
 */
export function resolveClaudeAllowedSkills(
  env: Record<string, string | undefined> = process.env,
): readonly string[] {
  const raw = env.SF_CLAUDE_ALLOWED_SKILLS?.trim();
  if (raw === undefined || raw.length === 0) {
    return [];
  }
  if (raw === '*') {
    return ['*'];
  }
  return raw
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

/**
 * Preferred skill families to steer workers toward — adapter-agnostic
 * guidance (`SF_PREFERRED_SKILLS`; the older `SF_CLAUDE_PREFERRED_SKILLS`
 * name still works). Codex loads its skill catalog natively; Claude also
 * needs `SF_CLAUDE_ALLOWED_SKILLS` before the guidance has any effect.
 */
export function resolvePreferredSkills(
  env: Record<string, string | undefined> = process.env,
): readonly string[] {
  const raw = (env.SF_PREFERRED_SKILLS ?? env.SF_CLAUDE_PREFERRED_SKILLS)?.trim();
  if (raw === undefined || raw.length === 0) {
    return [];
  }
  return raw
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

/** The env-derived options every default-catalog construction site must use. */
export function resolveAdapterCatalogOptions(
  env: Record<string, string | undefined> = process.env,
): DefaultAdapterCatalogOptions {
  return {
    claudeAllowedSkills: resolveClaudeAllowedSkills(env),
    preferredSkills: resolvePreferredSkills(env),
  };
}
