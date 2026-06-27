/**
 * render-config (U9) — blueprint generation, YAML serialization, and validation.
 *
 * The default blueprint must match the generated app (prisma migrate deploy +
 * next build, next start, /api/status health, a Postgres db wired into
 * DATABASE_URL), and validation must CATCH missing build / start / migration /
 * env / health fields with structured error codes.
 */
import { describe, expect, it } from 'vitest';
import {
  buildRenderBlueprint,
  generateRenderConfig,
  renderBlueprintToYaml,
  validateRenderBlueprint,
} from '../../src/index';
import type { RenderBlueprint } from '../../src/index';

function withWebPatch(patch: Partial<RenderBlueprint['services'][number]>): RenderBlueprint {
  const base = buildRenderBlueprint();
  return {
    ...base,
    services: [{ ...base.services[0], ...patch }],
  };
}

describe('buildRenderBlueprint', () => {
  it('produces a valid default blueprint matching the generated app', () => {
    const { blueprint, validation } = generateRenderConfig();
    expect(validation.valid).toBe(true);

    const web = blueprint.services[0];
    expect(web.type).toBe('web');
    expect(web.buildCommand).toMatch(/prisma\s+migrate\s+deploy/);
    expect(web.buildCommand).toMatch(/build/);
    expect(web.startCommand).toMatch(/start/);
    expect(web.healthCheckPath).toBe('/api/status');

    // DATABASE_URL is sourced from the defined Postgres database.
    const databaseUrl = web.envVars.find((v) => v.key === 'DATABASE_URL');
    expect(databaseUrl?.fromDatabase?.name).toBe(blueprint.databases[0].name);
    expect(blueprint.databases).toHaveLength(1);
  });

  it('serializes to render.yaml text with services + databases', () => {
    const yaml = renderBlueprintToYaml(buildRenderBlueprint());
    expect(yaml).toContain('services:');
    expect(yaml).toContain('type: web');
    expect(yaml).toContain('healthCheckPath: /api/status');
    expect(yaml).toContain('databases:');
    expect(yaml).toContain('fromDatabase:');
    expect(yaml).toContain('property: connectionString');
  });
});

describe('validateRenderBlueprint', () => {
  it('catches a missing build command', () => {
    const result = validateRenderBlueprint(withWebPatch({ buildCommand: '' }));
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain('missing_build');
  });

  it('catches a missing migration step in the build command', () => {
    const result = validateRenderBlueprint(withWebPatch({ buildCommand: 'pnpm install && pnpm build' }));
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain('missing_migration');
  });

  it('catches a missing start command', () => {
    const result = validateRenderBlueprint(withWebPatch({ startCommand: '' }));
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain('missing_start');
  });

  it('catches a missing / non-absolute health check path', () => {
    const result = validateRenderBlueprint(withWebPatch({ healthCheckPath: '' }));
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain('missing_health_check');
  });

  it('catches a missing DATABASE_URL env var', () => {
    const result = validateRenderBlueprint(withWebPatch({ envVars: [{ key: 'NODE_ENV', value: 'production' }] }));
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain('missing_database_url');
  });

  it('catches a missing database service', () => {
    const base = buildRenderBlueprint();
    const result = validateRenderBlueprint({ ...base, databases: [] });
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain('missing_database_service');
  });

  it('reports multiple structured errors at once', () => {
    const result = validateRenderBlueprint(
      withWebPatch({ buildCommand: 'echo nope', startCommand: '', healthCheckPath: 'relative' }),
    );
    expect(result.valid).toBe(false);
    const codes = result.errors.map((e) => e.code);
    expect(codes).toContain('missing_migration');
    expect(codes).toContain('missing_start');
    expect(codes).toContain('missing_health_check');
    // every error carries a field + message for the operator
    for (const error of result.errors) {
      expect(error.field.length).toBeGreaterThan(0);
      expect(error.message.length).toBeGreaterThan(0);
    }
  });
});
