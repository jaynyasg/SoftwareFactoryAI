/**
 * Research source adapters (full-factory U2) — workspace containment for the
 * repo/local scan (Windows-safe traversal rejection), honest PRD handling
 * (text vs reference metadata), and injected-fetcher documentation / provider
 * web-search behavior. No network anywhere; repo tests use a temp workspace.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDocumentationAdapter,
  createPrdAdapter,
  createRepoScanAdapter,
  createWebSearchAdapter,
} from '../../src/index';
import type { ResearchFetchResult, ResearchRunContext, WebSearchProvider } from '../../src/index';

const CONTEXT: ResearchRunContext = { runId: 'run-1', objective: 'test objective' };

describe('createRepoScanAdapter', () => {
  let workspace: string;
  let outside: string;

  beforeAll(async () => {
    const base = await mkdtemp(join(tmpdir(), 'sf-research-'));
    workspace = join(base, 'workspace');
    outside = join(base, 'outside');
    await mkdir(workspace, { recursive: true });
    await mkdir(join(workspace, 'docs'), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(workspace, 'README.md'), '# Demo App\nA demo.', 'utf8');
    await writeFile(
      join(workspace, 'package.json'),
      JSON.stringify({ name: 'demo-app', dependencies: { react: '^19.0.0' } }),
      'utf8',
    );
    await writeFile(join(workspace, 'docs', 'notes.md'), '# Notes', 'utf8');
    await writeFile(join(outside, 'secrets.txt'), 'do-not-read', 'utf8');
  });

  afterAll(async () => {
    await rm(resolve(workspace, '..'), { recursive: true, force: true });
  });

  it('discovers and reads files inside the workspace deterministically', async () => {
    const adapter = createRepoScanAdapter({ workspaceRoot: workspace });
    expect((await adapter.detectSetup()).configured).toBe(true);

    const sources = await adapter.discover(CONTEXT, { limit: 10 });
    const locators = sources.map((source) => source.locator);
    expect(locators).toContain('README.md');
    expect(locators).toContain('package.json');
    expect(locators).toContain('docs/notes.md');
    // Priority files first, stable order.
    expect(locators[0]).toBe('README.md');

    const readme = await adapter.read(sources[0], {});
    expect(readme.contentDigest).toHaveLength(64);
    expect(readme.findings?.[0]?.classification).toBe('verified_fact');
    expect(readme.findings?.[0]?.statement).toContain('# Demo App');

    const pkg = await adapter.read(
      sources.find((source) => source.locator === 'package.json')!,
      {},
    );
    expect(pkg.findings?.[0]?.statement).toContain('demo-app');
    expect(pkg.findings?.[0]?.knowledgeKind).toBe('repo_fact');
  });

  it('reports not-configured when the scan folder escapes the workspace boundary', async () => {
    const adapter = createRepoScanAdapter({ workspaceRoot: workspace, folder: '../outside' });
    const setup = await adapter.detectSetup();
    expect(setup.configured).toBe(false);
    expect(setup.detail).toMatch(/escapes the approved workspace boundary/i);
    await expect(adapter.discover(CONTEXT, { limit: 10 })).rejects.toThrow(/escapes/i);
  });

  it('rejects relative path traversal in read locators', async () => {
    const adapter = createRepoScanAdapter({ workspaceRoot: workspace });
    await expect(
      adapter.read(
        { sourceId: 'repo-scan:evil', kind: 'repo_scan', locator: '../outside/secrets.txt' },
        {},
      ),
    ).rejects.toThrow(/traversal rejected/i);
  });

  it('rejects absolute locators outside the workspace (Windows-safe)', async () => {
    const adapter = createRepoScanAdapter({ workspaceRoot: workspace });
    const absoluteOutside = join(outside, 'secrets.txt');
    await expect(
      adapter.read({ sourceId: 'repo-scan:abs', kind: 'repo_scan', locator: absoluteOutside }, {}),
    ).rejects.toThrow(/traversal rejected/i);
  });

  it('reports not-configured for a missing folder instead of throwing at setup', async () => {
    const adapter = createRepoScanAdapter({ workspaceRoot: workspace, folder: 'nope' });
    const setup = await adapter.detectSetup();
    expect(setup.configured).toBe(false);
    expect(setup.detail).toMatch(/does not exist/i);
  });
});

describe('createPrdAdapter', () => {
  it('reads uploaded PRD text with a deterministic digest and heading findings', async () => {
    const prdText = '# Marketplace PRD\n\n## Goals\nShip it.\n\n## Non-goals\nEverything else.';
    const adapter = createPrdAdapter({ prdText, prdRef: 'docs/PRD.md' });
    expect((await adapter.detectSetup()).configured).toBe(true);

    const sources = await adapter.discover(CONTEXT, { limit: 5 });
    expect(sources).toHaveLength(1);
    expect(sources[0].sourceId).toBe('prd:text');

    const first = await adapter.read(sources[0], {});
    const second = await adapter.read(sources[0], {});
    expect(first.contentDigest).toBe(second.contentDigest);
    const statements = (first.findings ?? []).map((finding) => finding.statement);
    expect(statements).toContain('PRD section: Marketplace PRD');
    expect(statements).toContain('PRD section: Goals');
    expect(first.findings?.every((finding) => finding.classification === 'verified_fact')).toBe(
      true,
    );
  });

  it('records a gap (not fabricated findings) for PRD reference metadata without content', async () => {
    const adapter = createPrdAdapter({ prdRef: 'docs/PRD.md' });
    const sources = await adapter.discover(CONTEXT, { limit: 5 });
    expect(sources).toHaveLength(1);
    expect(sources[0].sourceId).toBe('prd:ref');

    const result = await adapter.read(sources[0], {});
    expect(result.findings ?? []).toHaveLength(0);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps?.[0]?.question).toMatch(/content is not available/i);
  });

  it('is not configured when the run carries no PRD input', async () => {
    const adapter = createPrdAdapter({});
    expect((await adapter.detectSetup()).configured).toBe(false);
  });
});

describe('createDocumentationAdapter', () => {
  it('fetches configured URLs through the injected fetcher only', async () => {
    const fetched: string[] = [];
    const fetcher = (url: string): Promise<ResearchFetchResult> => {
      fetched.push(url);
      return Promise.resolve({ status: 200, body: '<h1>Docs</h1><p>Use the API wisely.</p>' });
    };
    const adapter = createDocumentationAdapter({
      urls: ['https://docs.example.com/api'],
      fetcher,
    });
    expect((await adapter.detectSetup()).configured).toBe(true);

    const sources = await adapter.discover(CONTEXT, { limit: 5 });
    expect(sources).toHaveLength(1);
    const result = await adapter.read(sources[0], {});
    expect(fetched).toEqual(['https://docs.example.com/api']);
    expect(result.findings?.[0]?.statement).toContain('Use the API wisely.');
    expect(result.findings?.[0]?.statement).not.toContain('<h1>');
  });

  it('is not configured without URLs and throws on non-2xx fetches', async () => {
    const none = createDocumentationAdapter({
      urls: [],
      fetcher: () => Promise.reject(new Error('x')),
    });
    expect((await none.detectSetup()).configured).toBe(false);

    const failing = createDocumentationAdapter({
      urls: ['https://docs.example.com/missing'],
      fetcher: () => Promise.resolve({ status: 404, body: 'nope' }),
    });
    const sources = await failing.discover(CONTEXT, { limit: 1 });
    await expect(failing.read(sources[0], {})).rejects.toThrow(/HTTP 404/);
  });
});

describe('createWebSearchAdapter', () => {
  it('fails closed with a setup action when no provider is configured', async () => {
    const adapter = createWebSearchAdapter({});
    const setup = await adapter.detectSetup();
    expect(setup.configured).toBe(false);
    expect(setup.requiresCredentials).toBe(true);
    expect(setup.credentialsPresent).toBe(false);
    expect(setup.setupAction?.title).toMatch(/web-search provider/i);
    await expect(adapter.discover(CONTEXT, { limit: 3 })).rejects.toThrow(
      /no web-search provider/i,
    );
  });

  it('reports missing provider credentials as presence booleans only', async () => {
    const provider: WebSearchProvider = {
      id: 'fake-search',
      detectSetup: () => Promise.resolve({ credentialsPresent: false, detail: 'API key missing' }),
      search: () => Promise.resolve([]),
    };
    const setup = await createWebSearchAdapter({ provider }).detectSetup();
    expect(setup.configured).toBe(true);
    expect(setup.credentialsPresent).toBe(false);
    expect(setup.setupAction).toBeDefined();
  });

  it('maps provider results to inference-grade findings', async () => {
    const provider: WebSearchProvider = {
      id: 'fake-search',
      detectSetup: () => Promise.resolve({ credentialsPresent: true }),
      search: (query, options) =>
        Promise.resolve(
          [
            { title: `Result for ${query}`, url: 'https://example.com/a', snippet: 'snippet A' },
            { title: 'Second', url: 'https://example.com/b', snippet: 'snippet B' },
          ].slice(0, options.limit),
        ),
    };
    const adapter = createWebSearchAdapter({ provider });
    const sources = await adapter.discover(CONTEXT, { limit: 1 });
    expect(sources).toHaveLength(1);
    expect(sources[0].locator).toBe('https://example.com/a');

    const result = await adapter.read(sources[0], {});
    expect(result.findings?.[0]?.classification).toBe('inference');
    expect(result.findings?.[0]?.confidence).toBe(0.5);
  });
});
