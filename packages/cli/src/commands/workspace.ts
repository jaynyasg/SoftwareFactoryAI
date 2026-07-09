/**
 * Workspace materialization verbs (full-factory U4):
 *
 *   software-factory materialize-workspace <runId> [--branch <b>]
 *   software-factory workspace-status      <runId>
 *
 * Materialization is SEPARATE from execution: a cloud agent that creates a run
 * with `githubRepo` triggers materialization (repository checkout) before
 * starting execution; without it the run blocks with no agent-accessible
 * remedy. `materialize-workspace` converges on retry — an already-ready
 * workspace is reused, unchanged-unavailable evidence dedups, and new checkout
 * attempts increment an explicit attempt counter. The mutating trigger resolves
 * a fresh `expectedVersion` automatically (unless pinned) so the guard's stale-
 * version protection stays effective.
 */
import type { ApiClient, MaterializeWorkspaceResult, WorkspaceStatusResult } from '../api-client';
import type { CliIo } from '../cli-io';

export interface MaterializeWorkspaceArgs {
  readonly runId: string;
  readonly branch?: string;
  readonly expectedVersion?: number;
  readonly json?: boolean;
}

export interface WorkspaceStatusArgs {
  readonly runId: string;
  readonly json?: boolean;
}

export interface WorkspaceCommandDeps {
  readonly client: ApiClient;
  readonly io: CliIo;
}

/** Read a stable string field from a passthrough workspace/result record. */
function field(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** The materialized path (local folder or repo checkout), when ready. */
function workspacePath(workspace: Record<string, unknown> | undefined): string | undefined {
  const nested = workspace?.workspace;
  const record =
    typeof nested === 'object' && nested !== null ? (nested as Record<string, unknown>) : undefined;
  return field(record, 'path') ?? field(record, 'checkoutPath');
}

/** The most informative reason across a workspace projection's failure fields. */
function workspaceReason(workspace: Record<string, unknown> | undefined): string | undefined {
  return (
    field(workspace, 'failureReason') ??
    field(workspace, 'unavailableReason') ??
    field(workspace, 'requiredAction')
  );
}

export async function materializeWorkspaceCommand(
  args: MaterializeWorkspaceArgs,
  deps: WorkspaceCommandDeps,
): Promise<MaterializeWorkspaceResult> {
  const expectedVersion =
    args.expectedVersion ?? (await deps.client.getRun(args.runId)).lastSequence;
  const result = await deps.client.materializeWorkspace(args.runId, {
    branch: args.branch,
    expectedVersion,
  });
  if (args.json === true) {
    deps.io.out(JSON.stringify(result, null, 2));
    return result;
  }
  const status = field(result.workspace, 'status') ?? 'unknown';
  const reason = workspaceReason(result.workspace) ?? field(result.result, 'reason');
  deps.io.out(`${result.runId}: workspace ${status}${reason !== undefined ? ` — ${reason}` : ''}`);
  return result;
}

export async function workspaceStatusCommand(
  args: WorkspaceStatusArgs,
  deps: WorkspaceCommandDeps,
): Promise<WorkspaceStatusResult> {
  const result = await deps.client.getWorkspace(args.runId);
  if (args.json === true) {
    deps.io.out(JSON.stringify(result, null, 2));
    return result;
  }
  const status = field(result.workspace, 'status') ?? 'unknown';
  const path = workspacePath(result.workspace);
  const reason = workspaceReason(result.workspace);
  const detail = path !== undefined ? ` (${path})` : reason !== undefined ? ` — ${reason}` : '';
  deps.io.out(`${result.runId}: workspace ${status}${detail}`);
  return result;
}
