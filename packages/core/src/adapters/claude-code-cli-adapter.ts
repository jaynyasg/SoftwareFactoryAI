/**
 * Claude Code CLI execution adapter (local / BYO).
 *
 * Runs work through the user's authenticated local `claude` CLI. Like the Codex
 * adapter it is a thin configuration over `createCliAdapter`; only the command,
 * probe arguments, execution-argument composition, and remediation actions
 * differ. The `CommandRunner` is injected for testability; the Node-backed
 * runner is only the default.
 */
import { createCliAdapter } from './cli-adapter-base';
import { createNodeCommandRunner } from './node-command-runner';
import type {
  AdapterTask,
  CommandRunner,
  ExecutionAdapter,
  SetupAction,
} from './execution-adapter';

/** Options for constructing a Claude Code adapter. */
export interface ClaudeCodeCliAdapterOptions {
  /** Injected process runner. Defaults to the Node `child_process` runner. */
  readonly runner?: CommandRunner;
  /** Override the adapter id (defaults to `claude-code-cli`). */
  readonly id?: string;
  /** Override the executable name (defaults to `claude`). */
  readonly command?: string;
  /** Declared local concurrency when available (defaults to 4). */
  readonly capacity?: number;
}

const DEFAULT_CAPACITY = 4;

const INSTALL_ACTIONS: readonly SetupAction[] = [
  {
    id: 'claude.install',
    title: 'Install the Claude Code CLI',
    description: 'The `claude` executable was not found on PATH.',
    command: 'npm install -g @anthropic-ai/claude-code',
    href: 'https://docs.anthropic.com/en/docs/claude-code',
  },
];

const LOGIN_ACTIONS: readonly SetupAction[] = [
  {
    id: 'claude.login',
    title: 'Authenticate the Claude Code CLI',
    description: 'The Claude Code CLI is installed but has no active session.',
    command: 'claude login',
  },
];

/** Compose the non-interactive Claude Code execution arguments for a task. */
function buildExecArgs(task: AdapterTask): readonly string[] {
  const args = ['--print', '--output-format', 'json'];
  if (task.context.allowedTools.length > 0) {
    args.push('--allowedTools', task.context.allowedTools.join(','));
  }
  args.push(composePrompt(task));
  return args;
}

function composePrompt(task: AdapterTask): string {
  return [`Ticket ${task.ticketId}: ${task.title}`, task.context.prompt]
    .filter((part) => part.length > 0)
    .join('\n\n');
}

/** Create a Claude Code CLI execution adapter. */
export function createClaudeCodeCliAdapter(
  options: ClaudeCodeCliAdapterOptions = {},
): ExecutionAdapter {
  const runner = options.runner ?? createNodeCommandRunner();
  return createCliAdapter(
    {
      id: options.id ?? 'claude-code-cli',
      family: 'claude',
      command: options.command ?? 'claude',
      versionArgs: ['--version'],
      // NOTE: the exact non-interactive auth-probe command for each CLI is
      // deferred (see U5 TODOS); `auth status` is a distinguishable placeholder.
      authArgs: ['auth', 'status'],
      buildExecArgs,
      capacity: options.capacity ?? DEFAULT_CAPACITY,
      installActions: INSTALL_ACTIONS,
      loginActions: LOGIN_ACTIONS,
    },
    { runner },
  );
}
