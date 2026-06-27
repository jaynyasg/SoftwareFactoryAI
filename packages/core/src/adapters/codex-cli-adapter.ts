/**
 * Codex CLI execution adapter (local / BYO).
 *
 * Runs work through the user's authenticated local `codex` CLI. It is a thin
 * configuration over `createCliAdapter`: it knows the executable name, how to
 * probe version/auth, how to compose the execution arguments from a task, and
 * which remediation actions to surface when setup is incomplete. The
 * `CommandRunner` is injected so the adapter is fully testable without the CLI;
 * the Node-backed runner is only the default.
 */
import { createCliAdapter } from './cli-adapter-base';
import { createNodeCommandRunner } from './node-command-runner';
import type {
  AdapterTask,
  CommandRunner,
  ExecutionAdapter,
  SetupAction,
} from './execution-adapter';

/** Options for constructing a Codex adapter. */
export interface CodexCliAdapterOptions {
  /** Injected process runner. Defaults to the Node `child_process` runner. */
  readonly runner?: CommandRunner;
  /** Override the adapter id (defaults to `codex-cli`). */
  readonly id?: string;
  /** Override the executable name (defaults to `codex`). */
  readonly command?: string;
  /** Declared local concurrency when available (defaults to 4). */
  readonly capacity?: number;
}

const DEFAULT_CAPACITY = 4;

const INSTALL_ACTIONS: readonly SetupAction[] = [
  {
    id: 'codex.install',
    title: 'Install the Codex CLI',
    description: 'The `codex` executable was not found on PATH.',
    command: 'npm install -g @openai/codex',
    href: 'https://github.com/openai/codex',
  },
];

const LOGIN_ACTIONS: readonly SetupAction[] = [
  {
    id: 'codex.login',
    title: 'Authenticate the Codex CLI',
    description: 'The Codex CLI is installed but has no active session.',
    command: 'codex login',
  },
];

/** Compose the non-interactive Codex execution arguments for a task. */
function buildExecArgs(task: AdapterTask): readonly string[] {
  return ['exec', '--cd', task.workspaceDir, '--json', composePrompt(task)];
}

function composePrompt(task: AdapterTask): string {
  const { context } = task;
  const tools =
    context.allowedTools.length > 0 ? `Allowed tools: ${context.allowedTools.join(', ')}.` : '';
  return [`Ticket ${task.ticketId}: ${task.title}`, context.prompt, tools]
    .filter((part) => part.length > 0)
    .join('\n\n');
}

/** Create a Codex CLI execution adapter. */
export function createCodexCliAdapter(options: CodexCliAdapterOptions = {}): ExecutionAdapter {
  const runner = options.runner ?? createNodeCommandRunner();
  return createCliAdapter(
    {
      id: options.id ?? 'codex-cli',
      family: 'codex',
      command: options.command ?? 'codex',
      versionArgs: ['--version'],
      authArgs: ['login', 'status'],
      buildExecArgs,
      capacity: options.capacity ?? DEFAULT_CAPACITY,
      installActions: INSTALL_ACTIONS,
      loginActions: LOGIN_ACTIONS,
    },
    { runner },
  );
}
