/**
 * Generate AND validate a Render Blueprint (`render.yaml`) for the generated app.
 *
 * The blueprint matches the generated AI Services Marketplace template:
 *   - a `web` service whose BUILD runs prisma generate + `prisma migrate deploy`
 *     + `next build` (`pnpm build`), whose START runs `next start` (`pnpm start`),
 *     and whose `healthCheckPath` hits the app's `/api/status` route, and
 *   - a managed Postgres database, wired into the web service via a
 *     `DATABASE_URL` env var sourced from the database's connection string.
 *
 * `validateRenderBlueprint` returns STRUCTURED errors when the build / start /
 * migration / env (DATABASE_URL) / health fields are missing, so the deployer can
 * emit `deploy.config_invalid` with a concrete reason instead of failing opaquely.
 */

/** A Render env var (literal, generated, or sourced from a database). */
export interface RenderEnvVar {
  readonly key: string;
  readonly value?: string;
  readonly sync?: boolean;
  readonly generateValue?: boolean;
  readonly fromDatabase?: { readonly name: string; readonly property: 'connectionString' };
}

/** A Render web service definition. */
export interface RenderServiceConfig {
  readonly type: 'web';
  readonly name: string;
  readonly env: 'node';
  readonly plan?: string;
  readonly buildCommand: string;
  readonly startCommand: string;
  readonly healthCheckPath: string;
  readonly envVars: readonly RenderEnvVar[];
}

/** A Render managed Postgres database definition. */
export interface RenderDatabaseConfig {
  readonly name: string;
  readonly databaseName?: string;
  readonly user?: string;
  readonly plan?: string;
}

/** The full Render Blueprint. */
export interface RenderBlueprint {
  readonly services: readonly RenderServiceConfig[];
  readonly databases: readonly RenderDatabaseConfig[];
}

/** Options controlling blueprint generation. */
export interface RenderConfigOptions {
  readonly serviceName?: string;
  readonly databaseName?: string;
  readonly healthCheckPath?: string;
  readonly buildCommand?: string;
  readonly startCommand?: string;
  readonly plan?: string;
  readonly databasePlan?: string;
  readonly extraEnvVars?: readonly RenderEnvVar[];
}

/** Defaults that match the generated app template (`/api/status`, prisma, next). */
export const DEFAULT_SERVICE_NAME = 'ai-services-marketplace';
export const DEFAULT_HEALTH_CHECK_PATH = '/api/status';
export const DEFAULT_BUILD_COMMAND =
  'pnpm install && pnpm exec prisma generate && pnpm exec prisma migrate deploy && pnpm build';
export const DEFAULT_START_COMMAND = 'pnpm start';

/** Build the Render blueprint for the generated app. */
export function buildRenderBlueprint(options: RenderConfigOptions = {}): RenderBlueprint {
  const serviceName = options.serviceName ?? DEFAULT_SERVICE_NAME;
  const databaseName = options.databaseName ?? `${serviceName}-db`;

  const envVars: RenderEnvVar[] = [
    { key: 'DATABASE_URL', fromDatabase: { name: databaseName, property: 'connectionString' } },
    { key: 'NODE_ENV', value: 'production' },
    // Optional live AI brief provider — left unsynced so the app uses its
    // deterministic fallback unless the operator sets it in the Render dashboard.
    { key: 'AI_BRIEF_PROVIDER', sync: false },
    { key: 'AI_BRIEF_API_KEY', sync: false },
    ...(options.extraEnvVars ?? []),
  ];

  return {
    services: [
      {
        type: 'web',
        name: serviceName,
        env: 'node',
        plan: options.plan ?? 'starter',
        buildCommand: options.buildCommand ?? DEFAULT_BUILD_COMMAND,
        startCommand: options.startCommand ?? DEFAULT_START_COMMAND,
        healthCheckPath: options.healthCheckPath ?? DEFAULT_HEALTH_CHECK_PATH,
        envVars,
      },
    ],
    databases: [
      {
        name: databaseName,
        databaseName: databaseName.replace(/-/g, '_'),
        user: `${serviceName.replace(/-/g, '_')}_user`,
        plan: options.databasePlan ?? 'starter',
      },
    ],
  };
}

/* ----------------------------------------------------------------------------
 * Validation
 * ------------------------------------------------------------------------- */

/** A structured validation error. */
export interface RenderConfigError {
  readonly code: string;
  readonly field: string;
  readonly message: string;
}

/** The validation result. */
export interface RenderConfigValidation {
  readonly valid: boolean;
  readonly errors: readonly RenderConfigError[];
}

const MIGRATION_PATTERN = /prisma\s+migrate\s+deploy/;
const BUILD_STEP_PATTERN = /(next build|(?:pnpm|npm|yarn)(?:\s+run)?\s+build)/;
const START_PATTERN = /(next start|(?:pnpm|npm|yarn)(?:\s+run)?\s+start)/;

/**
 * Validate a blueprint, returning structured errors for any missing
 * build / start / migration / env / health fields.
 */
export function validateRenderBlueprint(blueprint: RenderBlueprint): RenderConfigValidation {
  const errors: RenderConfigError[] = [];

  const web = blueprint.services.find((service) => service.type === 'web');
  if (web === undefined) {
    errors.push({
      code: 'missing_web_service',
      field: 'services',
      message: 'No web service is defined in the blueprint.',
    });
    return { valid: false, errors };
  }

  // build
  if (web.buildCommand === undefined || web.buildCommand.trim().length === 0) {
    errors.push({
      code: 'missing_build',
      field: 'services[web].buildCommand',
      message: 'buildCommand is required.',
    });
  } else if (!BUILD_STEP_PATTERN.test(web.buildCommand)) {
    errors.push({
      code: 'missing_build_step',
      field: 'services[web].buildCommand',
      message: 'buildCommand must run a build step (e.g. "next build" / "pnpm build").',
    });
  }

  // migration (inside build)
  if (web.buildCommand === undefined || !MIGRATION_PATTERN.test(web.buildCommand)) {
    errors.push({
      code: 'missing_migration',
      field: 'services[web].buildCommand',
      message: 'buildCommand must run database migrations ("prisma migrate deploy").',
    });
  }

  // start
  if (web.startCommand === undefined || web.startCommand.trim().length === 0) {
    errors.push({
      code: 'missing_start',
      field: 'services[web].startCommand',
      message: 'startCommand is required.',
    });
  } else if (!START_PATTERN.test(web.startCommand)) {
    errors.push({
      code: 'missing_start_step',
      field: 'services[web].startCommand',
      message: 'startCommand must start the server (e.g. "next start" / "pnpm start").',
    });
  }

  // health
  if (
    web.healthCheckPath === undefined ||
    web.healthCheckPath.trim().length === 0 ||
    !web.healthCheckPath.startsWith('/')
  ) {
    errors.push({
      code: 'missing_health_check',
      field: 'services[web].healthCheckPath',
      message: 'healthCheckPath must be an absolute path (e.g. "/api/status").',
    });
  }

  // env: DATABASE_URL must be present, and a database must back it
  const databaseUrl = web.envVars.find((envVar) => envVar.key === 'DATABASE_URL');
  if (databaseUrl === undefined) {
    errors.push({
      code: 'missing_database_url',
      field: 'services[web].envVars',
      message: 'A DATABASE_URL env var is required.',
    });
  } else if (
    databaseUrl.fromDatabase === undefined &&
    (databaseUrl.value === undefined || databaseUrl.value.length === 0)
  ) {
    errors.push({
      code: 'empty_database_url',
      field: 'services[web].envVars.DATABASE_URL',
      message: 'DATABASE_URL must have a value or be sourced from a database.',
    });
  }

  if (blueprint.databases.length === 0) {
    errors.push({
      code: 'missing_database_service',
      field: 'databases',
      message: 'A Postgres database service is required.',
    });
  } else if (
    databaseUrl?.fromDatabase !== undefined &&
    !blueprint.databases.some((database) => database.name === databaseUrl.fromDatabase?.name)
  ) {
    errors.push({
      code: 'database_ref_unresolved',
      field: 'services[web].envVars.DATABASE_URL.fromDatabase',
      message: `DATABASE_URL references database "${databaseUrl.fromDatabase.name}", which is not defined.`,
    });
  }

  return { valid: errors.length === 0, errors };
}

/* ----------------------------------------------------------------------------
 * YAML serialization (hand-rolled for this known, flat structure)
 * ------------------------------------------------------------------------- */

function yamlScalar(value: string | number | boolean): string {
  if (typeof value !== 'string') {
    return String(value);
  }
  // Quote when the scalar contains characters that would confuse a YAML reader.
  if (value.length === 0 || /[:#{}[\],&*?|<>=!%@`"']/.test(value) || /^\s|\s$/.test(value)) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return value;
}

function envVarToYaml(envVar: RenderEnvVar): string[] {
  const lines = [`      - key: ${yamlScalar(envVar.key)}`];
  if (envVar.value !== undefined) {
    lines.push(`        value: ${yamlScalar(envVar.value)}`);
  }
  if (envVar.sync !== undefined) {
    lines.push(`        sync: ${envVar.sync}`);
  }
  if (envVar.generateValue !== undefined) {
    lines.push(`        generateValue: ${envVar.generateValue}`);
  }
  if (envVar.fromDatabase !== undefined) {
    lines.push(
      '        fromDatabase:',
      `          name: ${yamlScalar(envVar.fromDatabase.name)}`,
      `          property: ${yamlScalar(envVar.fromDatabase.property)}`,
    );
  }
  return lines;
}

/** Serialize a blueprint to `render.yaml` text. */
export function renderBlueprintToYaml(blueprint: RenderBlueprint): string {
  const lines: string[] = ['services:'];
  for (const service of blueprint.services) {
    lines.push(
      `  - type: ${yamlScalar(service.type)}`,
      `    name: ${yamlScalar(service.name)}`,
      `    env: ${yamlScalar(service.env)}`,
    );
    if (service.plan !== undefined) {
      lines.push(`    plan: ${yamlScalar(service.plan)}`);
    }
    lines.push(
      `    buildCommand: ${yamlScalar(service.buildCommand)}`,
      `    startCommand: ${yamlScalar(service.startCommand)}`,
      `    healthCheckPath: ${yamlScalar(service.healthCheckPath)}`,
    );
    if (service.envVars.length > 0) {
      lines.push('    envVars:');
      for (const envVar of service.envVars) {
        lines.push(...envVarToYaml(envVar));
      }
    }
  }

  if (blueprint.databases.length > 0) {
    lines.push('databases:');
    for (const database of blueprint.databases) {
      lines.push(`  - name: ${yamlScalar(database.name)}`);
      if (database.databaseName !== undefined) {
        lines.push(`    databaseName: ${yamlScalar(database.databaseName)}`);
      }
      if (database.user !== undefined) {
        lines.push(`    user: ${yamlScalar(database.user)}`);
      }
      if (database.plan !== undefined) {
        lines.push(`    plan: ${yamlScalar(database.plan)}`);
      }
    }
  }

  return `${lines.join('\n')}\n`;
}

/** The full result of generating a render config: blueprint + yaml + validation. */
export interface GeneratedRenderConfig {
  readonly blueprint: RenderBlueprint;
  readonly yaml: string;
  readonly validation: RenderConfigValidation;
}

/** Generate the blueprint, serialize it, and validate it in one call. */
export function generateRenderConfig(options: RenderConfigOptions = {}): GeneratedRenderConfig {
  const blueprint = buildRenderBlueprint(options);
  return {
    blueprint,
    yaml: renderBlueprintToYaml(blueprint),
    validation: validateRenderBlueprint(blueprint),
  };
}
