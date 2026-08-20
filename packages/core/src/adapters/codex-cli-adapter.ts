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
  /**
   * Skill names/families workers should PREFER when relevant, appended to
   * every ticket prompt. Codex loads `~/.codex/skills` natively (no gating),
   * but a large catalog overflows its skills context budget (descriptions
   * dropped, tail skills hidden) — explicit steering by name cuts through.
   */
  readonly preferredSkills?: readonly string[];
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

/**
 * A model override may carry a Codex config profile as `<profile>:<model>`
 * (e.g. `tfy:gpt-5.6-sol` → `--profile tfy --model gpt-5.6-sol`), so runs can
 * reach models served only by an alternate provider profile (~/.codex/
 * <profile>.config.toml). A bare id stays a plain `--model`.
 */
function parseModelOverride(model: string | undefined): {
  profile?: string;
  model?: string;
} {
  if (model === undefined) {
    return {};
  }
  const colon = model.indexOf(':');
  if (colon > 0 && /^[A-Za-z0-9_-]+$/.test(model.slice(0, colon))) {
    const rest = model.slice(colon + 1);
    return { profile: model.slice(0, colon), ...(rest.length > 0 ? { model: rest } : {}) };
  }
  return { model };
}

/** Compose the non-interactive Codex execution arguments for a task. */
function createBuildExecArgs(
  preferredSkills: readonly string[],
): (task: AdapterTask) => readonly string[] {
  const composePrompt = createComposePrompt(preferredSkills);
  return (task) => {
    const args = ['exec', '--cd', task.workspaceDir, '--json'];
    const override = parseModelOverride(task.model);
    if (override.profile !== undefined) {
      args.push('--profile', override.profile);
    }
    if (override.model !== undefined) {
      args.push('--model', override.model);
    }
    args.push(composePrompt(task));
    return args;
  };
}

function createComposePrompt(preferredSkills: readonly string[]): (task: AdapterTask) => string {
  // Codex loads its skill catalog natively, but a big catalog overflows the
  // skills context budget (descriptions dropped, tail skills hidden from the
  // visible list) — so the steering ALSO states that invoking by name works.
  const skillGuidance =
    preferredSkills.length === 0
      ? ''
      : `You have locally installed Codex skills. Prefer these skill families when they help deliver this ticket: ${preferredSkills.join(', ')}. A skill can be invoked by name even when it is not shown in your visible skills list.`;
  return (task) => {
    const { context } = task;
    const tools =
      context.allowedTools.length > 0 ? `Allowed tools: ${context.allowedTools.join(', ')}.` : '';
    return [`Ticket ${task.ticketId}: ${task.title}`, context.prompt, tools, skillGuidance]
      .filter((part) => part.length > 0)
      .join('\n\n');
  };
}

/**
 * Summarize one `codex exec --json` item as a live progress message, or
 * undefined for items that carry no operator signal (agent narration,
 * reasoning). Shapes observed on codex 0.148: item.type `command_execution`
 * ({command, exit_code, status}), `file_change` ({changes: [{path, kind}]}),
 * `error` ({message}), `agent_message` ({text}).
 */
function describeCodexItem(kind: string, item: Record<string, unknown>): string | undefined {
  if (item.type === 'command_execution' && kind === 'item.started') {
    const command = typeof item.command === 'string' ? item.command : '';
    return `Run: ${command.slice(0, 100)}`;
  }
  if (item.type === 'file_change' && kind === 'item.started') {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const labels = changes
      .map((change) => {
        const record = change as Record<string, unknown>;
        const verb =
          record.kind === 'add' ? 'Write' : record.kind === 'delete' ? 'Delete' : 'Edit';
        return typeof record.path === 'string' ? `${verb}: ${record.path}` : verb;
      })
      .slice(0, 3);
    return labels.length > 0 ? labels.join(' | ') : undefined;
  }
  if (item.type === 'error' && kind === 'item.completed') {
    const message = typeof item.message === 'string' ? item.message : 'unknown error';
    return `codex: ${message.slice(0, 140)}`;
  }
  return undefined;
}

/**
 * Stateful `codex exec --json` progress parser: buffers stdout into JSONL
 * lines and turns command/file items into short progress messages so
 * long-running tickets stay visible on the ledger. Best-effort only —
 * unparseable lines are ignored, never a correctness surface.
 */
export function createCodexProgressParser(): (
  stream: 'stdout' | 'stderr',
  chunk: string,
) => readonly string[] {
  let buffer = '';
  return (stream, chunk) => {
    if (stream !== 'stdout') {
      return [];
    }
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    const messages: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      try {
        const event = JSON.parse(trimmed) as Record<string, unknown>;
        if (
          (event.type === 'item.started' || event.type === 'item.completed') &&
          typeof event.item === 'object' &&
          event.item !== null
        ) {
          const message = describeCodexItem(
            event.type,
            event.item as Record<string, unknown>,
          );
          if (message !== undefined) {
            messages.push(message);
          }
        }
      } catch {
        // Partial or non-JSON line — visibility only, never fail the ticket.
      }
    }
    return messages;
  };
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
      buildExecArgs: createBuildExecArgs(options.preferredSkills ?? []),
      createProgressParser: createCodexProgressParser,
      capacity: options.capacity ?? DEFAULT_CAPACITY,
      installActions: INSTALL_ACTIONS,
      loginActions: LOGIN_ACTIONS,
    },
    { runner },
  );
}
