/**
 * A minimal Vercel API client behind the SAME injectable HTTP transport the
 * Render client uses (mirrors `../render/render-client.ts`): ensure/link a
 * project to the published GitHub repo, trigger a deployment, poll its state,
 * and check the hosted app's health. Tests inject a mock transport (or mock
 * the whole client) — no real network, no Vercel credentials.
 */
import { createFetchTransport } from '../render/render-client';
import type { HttpTransport } from '../render/render-client';

/** Vercel deployment ready-states (open union — Vercel may add more). */
export type VercelDeploymentState =
  | 'QUEUED'
  | 'BUILDING'
  | 'INITIALIZING'
  | 'READY'
  | 'ERROR'
  | 'CANCELED'
  | (string & {});

/** A Vercel deployment record (the subset we use). */
export interface VercelDeployment {
  readonly id: string;
  readonly state: VercelDeploymentState;
  /** The deployment host (no scheme), e.g. `my-app-abc123.vercel.app`. */
  readonly url?: string;
  /** A failure detail when the deployment errored. */
  readonly errorMessage?: string;
}

export interface VercelProject {
  readonly id: string;
  readonly name: string;
}

export interface EnsureProjectArgs {
  readonly name: string;
  /** GitHub repo to link (`owner/name`). */
  readonly repo: string;
  readonly signal?: AbortSignal;
}

export interface CreateDeploymentArgs {
  readonly projectName: string;
  /** GitHub repo (`owner/name`) and branch to deploy from. */
  readonly repo: string;
  readonly branch: string;
  readonly signal?: AbortSignal;
}

export interface GetDeploymentArgs {
  readonly deploymentId: string;
  readonly signal?: AbortSignal;
}

export interface VercelCheckHealthArgs {
  readonly url: string;
  readonly signal?: AbortSignal;
}

export interface VercelHealthResult {
  readonly healthy: boolean;
  readonly status: number;
}

export interface VercelClient {
  ensureProject(args: EnsureProjectArgs): Promise<VercelProject>;
  createDeployment(args: CreateDeploymentArgs): Promise<VercelDeployment>;
  getDeployment(args: GetDeploymentArgs): Promise<VercelDeployment>;
  checkHealth(args: VercelCheckHealthArgs): Promise<VercelHealthResult>;
}

export interface VercelClientOptions {
  readonly token?: string;
  readonly baseUrl?: string;
  readonly transport?: HttpTransport;
}

export const DEFAULT_VERCEL_BASE_URL = 'https://api.vercel.com';

/** A terminal deployment state (no further polling needed). */
export function isTerminalVercelState(state: VercelDeploymentState): boolean {
  return state === 'READY' || state === 'ERROR' || state === 'CANCELED';
}

/** Whether a terminal deployment state represents success. */
export function isVercelDeploySuccess(state: VercelDeploymentState): boolean {
  return state === 'READY';
}

function parseJson(body: string): Record<string, unknown> {
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function toDeployment(record: Record<string, unknown>): VercelDeployment {
  return {
    id: String(record.id ?? record.uid ?? 'unknown'),
    state: String(record.readyState ?? record.state ?? 'QUEUED') as VercelDeploymentState,
    url: typeof record.url === 'string' ? record.url : undefined,
    errorMessage:
      typeof (record.errorMessage as unknown) === 'string'
        ? (record.errorMessage as string)
        : undefined,
  };
}

export function createVercelClient(options: VercelClientOptions = {}): VercelClient {
  const baseUrl = (options.baseUrl ?? DEFAULT_VERCEL_BASE_URL).replace(/\/+$/, '');
  const transport = options.transport ?? createFetchTransport();
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(options.token !== undefined ? { authorization: `Bearer ${options.token}` } : {}),
  };

  async function request(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
    const response = await transport(
      {
        method,
        url: `${baseUrl}${path}`,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      },
      { signal },
    );
    return { ok: response.ok, status: response.status, json: parseJson(response.body) };
  }

  return {
    async ensureProject(args) {
      // Idempotent link: an existing project is reused; otherwise it is
      // created linked to the published GitHub repo.
      const existing = await request(
        'GET',
        `/v9/projects/${encodeURIComponent(args.name)}`,
        undefined,
        args.signal,
      );
      if (existing.ok) {
        return { id: String(existing.json.id ?? args.name), name: args.name };
      }
      const created = await request(
        'POST',
        '/v10/projects',
        { name: args.name, gitRepository: { type: 'github', repo: args.repo } },
        args.signal,
      );
      if (!created.ok) {
        throw new Error(
          `Vercel project create failed (${created.status}): ${String(
            (created.json.error as { message?: string } | undefined)?.message ?? 'unknown error',
          )}`,
        );
      }
      return { id: String(created.json.id ?? args.name), name: args.name };
    },

    async createDeployment(args) {
      const result = await request(
        'POST',
        '/v13/deployments',
        {
          name: args.projectName,
          gitSource: {
            type: 'github',
            org: args.repo.split('/')[0],
            repo: args.repo.split('/')[1],
            ref: args.branch,
          },
          target: 'production',
        },
        args.signal,
      );
      if (!result.ok) {
        throw new Error(
          `Vercel deployment create failed (${result.status}): ${String(
            (result.json.error as { message?: string } | undefined)?.message ?? 'unknown error',
          )}`,
        );
      }
      return toDeployment(result.json);
    },

    async getDeployment(args) {
      const result = await request(
        'GET',
        `/v13/deployments/${encodeURIComponent(args.deploymentId)}`,
        undefined,
        args.signal,
      );
      if (!result.ok) {
        throw new Error(`Vercel deployment read failed (${result.status}).`);
      }
      return toDeployment(result.json);
    },

    async checkHealth(args) {
      const response = await transport(
        { method: 'GET', url: args.url, headers: {} },
        { signal: args.signal },
      );
      return { healthy: response.ok, status: response.status };
    },
  };
}
