/**
 * Operator-token loading for the CLI.
 *
 * The CLI authenticates as the SAME local operator as the Factory Floor web UI.
 * Both read the file-backed operator session the web server persists under
 * `<workspaceRoot>/.factory/operator-token.json` (via core's
 * `createFileOperatorTokenStore`). So once the backend has minted a token, the
 * CLI picks it up with no extra setup.
 *
 * Resolution order for the token:
 *   1. `SF_API_TOKEN` env — YOUR personal API token on a multi-user factory
 *      (`sfai_…`, minted under Settings → API token; multi-user U4), else
 *   2. `SF_OPERATOR_TOKEN` env (single-tenant explicit override), else
 *   3. the shared `.factory/operator-token.json` file.
 *
 * Both env values travel through the SAME header slot (`x-operator-token` /
 * `Authorization: Bearer`) — the server's route layer tells them apart, so
 * existing single-tenant setups keep working with no changes.
 *
 * The `.factory` directory is resolved the same way the web server resolves it:
 *   1. `SF_FACTORY_DIR` env (explicit override), else
 *   2. walk up from the current working directory to the pnpm workspace root and
 *      append `.factory`.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createFileOperatorTokenStore } from '@software-factory/core';

export interface OperatorTokenEnv {
  /** Personal API token (`sfai_…`) for multi-user factories — wins over all. */
  readonly SF_API_TOKEN?: string;
  readonly SF_OPERATOR_TOKEN?: string;
  readonly SF_FACTORY_DIR?: string;
}

/** Resolve the shared `.factory` directory (mirrors the web server's logic). */
export function resolveFactoryDir(env: OperatorTokenEnv = process.env): string {
  const override = env.SF_FACTORY_DIR;
  if (override !== undefined && override.length > 0) {
    return override;
  }
  let dir = process.cwd();
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) {
      return join(dir, '.factory');
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return join(process.cwd(), '.factory');
}

/** The path to the shared operator-token file. */
export function operatorTokenPath(env: OperatorTokenEnv = process.env): string {
  return join(resolveFactoryDir(env), 'operator-token.json');
}

export interface LoadOperatorTokenOptions {
  /** Environment lookup (injectable for tests). Defaults to `process.env`. */
  readonly env?: OperatorTokenEnv;
  /** Explicit `.factory` path override (else resolved from env/cwd). */
  readonly factoryDir?: string;
}

/**
 * Load the caller's credential: `SF_API_TOKEN` (personal, multi-user) wins,
 * then the `SF_OPERATOR_TOKEN` override, then the shared file store. Returns
 * `null` when no token exists yet (the caller decides whether that blocks the
 * requested command).
 */
export async function loadOperatorToken(
  options: LoadOperatorTokenOptions = {},
): Promise<string | null> {
  const env = options.env ?? process.env;
  const personal = env.SF_API_TOKEN;
  if (personal !== undefined && personal.length > 0) {
    return personal;
  }
  const fromEnv = env.SF_OPERATOR_TOKEN;
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  const factoryDir = options.factoryDir ?? resolveFactoryDir(env);
  const store = createFileOperatorTokenStore(join(factoryDir, 'operator-token.json'));
  const session = await store.load();
  return session?.token ?? null;
}
