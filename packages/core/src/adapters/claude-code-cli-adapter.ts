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
import type { SpawnEnvBundle } from './session-env';
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
  /**
   * Per-user spawn-env bundle (multi-user U6): children spawn with an
   * EXCLUSIVE allowlisted env instead of inheriting the server's
   * `process.env`. See `createSpawnEnvBundle` / `CliAdapterDeps.spawnEnv`.
   */
  readonly spawnEnv?: SpawnEnvBundle;
  /** Override the adapter id (defaults to `claude-code-cli`). */
  readonly id?: string;
  /** Override the executable name (defaults to `claude`). */
  readonly command?: string;
  /** Declared local concurrency when available (defaults to 4). */
  readonly capacity?: number;
  /**
   * Claude Code SKILLS workers may invoke (opt-in; default NONE — fail
   * closed). The operator's machine can carry hundreds of installed skills,
   * including outward-facing ones (deploy, publish), so the `Skill` tool is
   * only put on the allow-list when skills are explicitly granted. `['*']`
   * permits any skill; a list of names permits the tool and instructs the
   * worker to use only those (prompt-level guidance — the CLI's tool gate is
   * per-tool, not per-skill).
   */
  readonly allowedSkills?: readonly string[];
  /**
   * Skill names/families workers should PREFER when relevant (guidance
   * appended to every ticket prompt). Only meaningful when `allowedSkills`
   * grants access; never widens the grant.
   */
  readonly preferredSkills?: readonly string[];
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

/**
 * Map the genome's abstract tool grants onto Claude Code's REAL tool names.
 * `--allowedTools` pre-approves tools in non-interactive `--print` mode —
 * without this mapping the CLI would receive names it does not know
 * (`fs.write`, `shell.exec`), silently deny every file write, and "complete"
 * tickets that built nothing. Names that already look like Claude Code tools
 * (capitalized) pass through unchanged.
 */
const GENOME_TOOL_MAP: Readonly<Record<string, readonly string[]>> = {
  'fs.read': ['Read', 'Glob', 'Grep'],
  'fs.write': ['Write', 'Edit'],
  'shell.exec': ['Bash'],
  'net.fetch': ['WebFetch'],
  'pkg.install': ['Bash'],
  'test.run': ['Bash'],
  'db.migrate': ['Bash'],
};

/** Translate genome tool grants to a deduped Claude Code allow-list. */
export function mapGenomeToolsToClaude(allowedTools: readonly string[]): readonly string[] {
  const mapped: string[] = [];
  for (const tool of allowedTools) {
    const targets = GENOME_TOOL_MAP[tool] ?? (/^[A-Z]/.test(tool) ? [tool] : []);
    for (const target of targets) {
      if (!mapped.includes(target)) {
        mapped.push(target);
      }
    }
  }
  return mapped;
}

/**
 * Compose the non-interactive Claude Code execution arguments for a task.
 * The prompt itself rides STDIN (`buildExecInput`), never the argv: on
 * Windows the `claude` executable is a `.cmd` shim re-invoked through
 * cmd.exe, whose command line cannot carry a multi-line prompt.
 */
function createBuildExecArgs(
  allowedSkills: readonly string[],
): (task: AdapterTask) => readonly string[] {
  return (task) => {
    // stream-json (NDJSON, requires --verbose) instead of plain json: plain
    // json stays SILENT until the ticket finishes, leaving long-running work
    // invisible; the stream lets the adapter emit live progress per tool use.
    const args = ['--print', '--output-format', 'stream-json', '--verbose'];
    if (task.model !== undefined) {
      args.push('--model', task.model);
    }
    const allowed = [...mapGenomeToolsToClaude(task.context.allowedTools)];
    if (allowedSkills.length > 0 && !allowed.includes('Skill')) {
      allowed.push('Skill');
    }
    if (allowed.length > 0) {
      args.push('--allowedTools', allowed.join(','));
    }
    return args;
  };
}

/**
 * Summarize one stream-json assistant content item as a progress message, or
 * undefined for items that carry no operator-meaningful signal (text deltas,
 * thinking). Tool uses ARE the "what is it doing right now" answer.
 */
function describeToolUse(item: Record<string, unknown>): string | undefined {
  if (item.type !== 'tool_use' || typeof item.name !== 'string') {
    return undefined;
  }
  const input = (item.input ?? {}) as Record<string, unknown>;
  const target =
    typeof input.file_path === 'string'
      ? input.file_path
      : typeof input.command === 'string'
        ? input.command.slice(0, 80)
        : typeof input.skill === 'string'
          ? input.skill
          : typeof input.pattern === 'string'
            ? input.pattern
            : undefined;
  return target !== undefined ? `${item.name}: ${target}` : item.name;
}

/**
 * Stateful stream-json progress parser: buffers stdout into NDJSON lines and
 * turns each assistant tool use into a short progress message. Stderr and
 * unparseable lines are ignored — progress is best-effort visibility, never
 * a correctness surface.
 */
export function createClaudeProgressParser(): (
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
        if (event.type === 'assistant') {
          const content = (event.message as Record<string, unknown> | undefined)?.content;
          if (Array.isArray(content)) {
            for (const item of content) {
              const message = describeToolUse(item as Record<string, unknown>);
              if (message !== undefined) {
                messages.push(message);
              }
            }
          }
        }
      } catch {
        // Partial or non-JSON line — visibility only, never fail the ticket.
      }
    }
    return messages;
  };
}

function createComposePrompt(
  allowedSkills: readonly string[],
  preferredSkills: readonly string[] = [],
): (task: AdapterTask) => string {
  const anySkill = allowedSkills.includes('*');
  const accessLine =
    allowedSkills.length === 0
      ? undefined
      : anySkill
        ? 'You may invoke any locally installed Claude Code skill (Skill tool) when it helps deliver this ticket.'
        : `You may invoke ONLY these Claude Code skills (Skill tool) when they help deliver this ticket: ${allowedSkills.join(', ')}. Do not invoke any other skill.`;
  const preferenceLine =
    accessLine !== undefined && preferredSkills.length > 0
      ? `Prefer these skill families when they are relevant to the ticket: ${preferredSkills.join(', ')}.`
      : undefined;
  const skillGuidance = [accessLine, preferenceLine].filter(Boolean).join(' ');
  return (task) =>
    [`Ticket ${task.ticketId}: ${task.title}`, task.context.prompt, skillGuidance]
      .filter((part) => part.length > 0)
      .join('\n\n');
}

/**
 * Parse the result envelope out of the CLI output. In stream-json mode the
 * envelope is the final `type:"result"` NDJSON line; in plain json mode it is
 * the whole stdout. A zero-exit envelope that still carries `is_error`/a
 * non-success subtype is a REAL failure and must not masquerade as ticket
 * output; a healthy envelope's `result` text is the ticket output (files land
 * in the workspace directly).
 */
function parseSuccess(result: { readonly stdout: string }): {
  readonly output: string;
  readonly artifacts: readonly [];
  readonly summary?: string;
} {
  const raw = result.stdout.trim();
  const lines = raw.split('\n');
  // Scan from the end: the result envelope is the last meaningful line in
  // stream mode, and the ONLY line in plain-json mode.
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (line.length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      continue;
    }
    const record = parsed as Record<string, unknown>;
    if (record.type !== undefined && record.type !== 'result') {
      continue;
    }
    if (record.is_error === true || (record.subtype !== undefined && record.subtype !== 'success')) {
      throw new Error(
        `claude reported an error envelope (subtype ${String(record.subtype ?? 'unknown')}): ${String(
          record.result ?? '',
        ).slice(0, 400)}`,
      );
    }
    if (typeof record.result === 'string') {
      return { output: record.result.trim(), artifacts: [] };
    }
  }
  // No envelope found (older CLI / plain text) — raw stdout is the output.
  return { output: raw, artifacts: [] };
}

/** Create a Claude Code CLI execution adapter. */
export function createClaudeCodeCliAdapter(
  options: ClaudeCodeCliAdapterOptions = {},
): ExecutionAdapter {
  const runner = options.runner ?? createNodeCommandRunner();
  const allowedSkills = options.allowedSkills ?? [];
  return createCliAdapter(
    {
      id: options.id ?? 'claude-code-cli',
      family: 'claude',
      command: options.command ?? 'claude',
      versionArgs: ['--version'],
      // Real non-interactive auth probe: `claude auth status` exits 0 with a
      // `loggedIn` JSON body on an authenticated CLI (verified on 2.x).
      authArgs: ['auth', 'status'],
      buildExecArgs: createBuildExecArgs(allowedSkills),
      buildExecInput: createComposePrompt(allowedSkills, options.preferredSkills),
      createProgressParser: createClaudeProgressParser,
      parseSuccess,
      capacity: options.capacity ?? DEFAULT_CAPACITY,
      installActions: INSTALL_ACTIONS,
      loginActions: LOGIN_ACTIONS,
    },
    { runner, spawnEnv: options.spawnEnv },
  );
}
