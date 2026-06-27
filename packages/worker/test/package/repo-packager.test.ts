/**
 * repo-packager (U9) — packages a generated-app dir as a committed git repo.
 *
 * Uses a REAL temp dir for the filesystem writes and a FAKE git CommandRunner
 * (no real git), so it asserts both that the factory metadata files land on disk
 * AND that the init -> add -> commit -> rev-parse sequence was issued, that the
 * commit hash is read back into the descriptor, and that `package.created` is
 * emitted with the repo path + handoff pointer.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assembleProvenanceBundle,
  computeArtifactConfidence,
  createInMemoryEventStore,
} from '@software-factory/core';
import type { CommandRunner, EventStore, FactoryEvent } from '@software-factory/core';
import { packageRepo, renderHandoffMarkdown } from '../../src/index';
import { createFakeRunner } from '../_helpers/fake-runner';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';

/** The git subcommand (skipping leading `-c key=val` global options + flags). */
function subcommand(args: readonly string[]): string {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '-c') {
      i += 1; // skip the `-c` value too
      continue;
    }
    if (!arg.startsWith('-')) {
      return arg;
    }
  }
  return '';
}

function gitRunner() {
  return createFakeRunner({
    responses: {
      'git rev-parse': { code: 0, stdout: `${COMMIT}\n`, stderr: '' },
    },
    // init / add / commit / remote all succeed silently.
    fallback: { code: 0, stdout: '', stderr: '' },
  });
}

async function ledger(store: EventStore): Promise<FactoryEvent[]> {
  await store.append({
    runId: 'run-pkg',
    type: 'run.created',
    actor: { kind: 'system', id: 'sys' },
    subject: { kind: 'run', id: 'run-pkg' },
    severity: 'info',
    payload: { prompt: 'Build an AI services marketplace' },
  });
  return store.readRun('run-pkg');
}

let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sf-repo-pkg-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('packageRepo', () => {
  it('writes the metadata files, commits, and emits package.created', async () => {
    const store = createInMemoryEventStore();
    const events = await ledger(store);
    const runner = gitRunner();

    const confidence = computeArtifactConfidence({
      gates: { passed: 5, total: 5 },
      testsPresent: true,
      provenanceCompleteness: 1,
      dependencyRisk: 'low',
      sandboxFallback: false,
      previewInspected: true,
    });
    const provenance = assembleProvenanceBundle({
      runId: 'run-pkg',
      artifactId: 'app',
      source: { prompt: 'Build an AI services marketplace' },
      ticketPlan: [{ id: 'T1', title: 'Scaffold' }],
      events,
      generatedFiles: [{ path: 'package.json' }],
      confidence,
    });
    const handoff = renderHandoffMarkdown({
      title: 'AI Services Marketplace',
      runId: 'run-pkg',
      artifactId: 'app',
      provenanceRef: 'PROVENANCE.json',
    });

    const descriptor = await packageRepo(
      {
        runId: 'run-pkg',
        artifactId: 'app',
        repoDir: dir,
        provenance,
        handoffMarkdown: handoff,
        ledgerExcerpt: events,
        envExample: 'DATABASE_URL="file:./dev.db"\n',
        testsSummaryMarkdown: '# Tests\n\n5/5 gates passed.\n',
      },
      { store, runner },
    );

    // Descriptor carries the path + the commit read back from `git rev-parse`.
    expect(descriptor.path).toBe(dir);
    expect(descriptor.commit).toBe(COMMIT);
    expect(descriptor.branch).toBe('main');
    expect(descriptor.files).toContain('PROVENANCE.json');
    expect(descriptor.files).toContain('HANDOFF.md');

    // Files actually exist on disk.
    const provenanceJson = JSON.parse(await readFile(join(dir, 'PROVENANCE.json'), 'utf8'));
    expect(provenanceJson.artifactId).toBe('app');
    expect(provenanceJson.version).toBe(1);
    expect(await readFile(join(dir, 'HANDOFF.md'), 'utf8')).toContain('Handoff');
    expect(await readFile(join(dir, '.env.example'), 'utf8')).toContain('DATABASE_URL');
    const ledgerLines = (await readFile(join(dir, '.factory/run-ledger.jsonl'), 'utf8'))
      .trim()
      .split('\n');
    expect(ledgerLines.length).toBe(events.length);
    expect(JSON.parse(ledgerLines[0]).type).toBe('run.created');
    expect(await readFile(join(dir, '.factory/tests-summary.md'), 'utf8')).toContain('gates passed');

    // Git command sequence: init -> add -> commit -> rev-parse.
    const gitVerbs = runner.calls.filter((c) => c.command === 'git').map((c) => subcommand(c.args));
    expect(gitVerbs).toEqual(['init', 'add', 'commit', 'rev-parse']);
    const commitCall = runner.calls.find(
      (c) => c.command === 'git' && subcommand(c.args) === 'commit',
    );
    expect(commitCall?.args).toContain('user.name=Software Factory');
    expect(commitCall?.args).toContain('commit.gpgsign=false');

    // package.created on the ledger with repo path + handoff pointer.
    const pkg = (await store.readRun('run-pkg')).find((e) => e.type === 'package.created');
    expect(pkg).toBeDefined();
    expect((pkg?.payload as { repoPath?: string }).repoPath).toBe(dir);
    expect((pkg?.payload as { handoffRef?: string }).handoffRef).toBe('HANDOFF.md');
  });

  it('throws an observable error when a git step fails', async () => {
    const store = createInMemoryEventStore();
    const events = await ledger(store);
    // Fail specifically on the commit (git invokes it with leading `-c` options).
    const runner: CommandRunner = {
      run: (command, args) =>
        command === 'git' && args.includes('commit')
          ? Promise.resolve({ code: 1, stdout: '', stderr: 'nothing to commit' })
          : Promise.resolve({ code: 0, stdout: '', stderr: '' }),
    };

    const confidence = computeArtifactConfidence({
      gates: { passed: 1, total: 1 },
      testsPresent: true,
      provenanceCompleteness: 1,
      dependencyRisk: 'low',
      sandboxFallback: false,
      previewInspected: true,
    });
    const provenance = assembleProvenanceBundle({
      runId: 'run-pkg',
      artifactId: 'app',
      source: { prompt: 'x marketplace y' },
      ticketPlan: [],
      events,
      generatedFiles: [],
      confidence,
    });

    await expect(
      packageRepo(
        {
          runId: 'run-pkg',
          artifactId: 'app',
          repoDir: dir,
          provenance,
          handoffMarkdown: '# Handoff\n',
          ledgerExcerpt: events,
        },
        { store, runner },
      ),
    ).rejects.toThrow(/nothing to commit/);

    // No package.created on a failed package.
    expect((await store.readRun('run-pkg')).some((e) => e.type === 'package.created')).toBe(false);
  });
});
