/**
 * Network-backed research adapters (full-factory U2): configured documentation
 * URLs and the external web-search provider hook.
 *
 * Both are NETWORK source classes, so the runner's source policy must allow
 * network access before either is consulted. Both fail closed:
 *  - the documentation adapter reports not-configured when no URLs/fetcher are
 *    supplied, and
 *  - the web-search adapter reports credentials-missing when no provider is
 *    configured (or the provider reports absent credentials) — the runner then
 *    records a setup requirement / gap instead of fabricating results.
 *
 * The fetcher and provider are INJECTED so tests never touch the network; the
 * `fetch`-backed `createHttpResearchFetcher` is only the runtime default.
 */
import { createHash } from 'node:crypto';
import type { SetupAction } from '@software-factory/core';
import type {
  DiscoverOptions,
  DiscoveredSource,
  ReadOptions,
  ResearchAdapterSetup,
  ResearchRunContext,
  ResearchSourceAdapter,
  SourceReadResult,
} from './research-contract';

/* ----------------------------------------------------------------------------
 * Documentation adapter
 * ------------------------------------------------------------------------- */

/** The terminal result of fetching one documentation URL. */
export interface ResearchFetchResult {
  readonly status: number;
  readonly body: string;
  readonly title?: string;
}

/** Injectable fetch abstraction (tests use fakes; runtime uses `fetch`). */
export type ResearchFetcher = (
  url: string,
  options?: { readonly signal?: AbortSignal },
) => Promise<ResearchFetchResult>;

/** Options for the documentation-URL adapter. */
export interface DocumentationAdapterOptions {
  /** Operator-configured documentation URLs (e.g. `SF_RESEARCH_DOC_URLS`). */
  readonly urls: readonly string[];
  /** Injectable fetcher; REQUIRED for the adapter to be configured. */
  readonly fetcher?: ResearchFetcher;
  /** Max characters kept from each fetched body (default 16 KiB). */
  readonly maxBodyChars?: number;
}

const DEFAULT_MAX_BODY_CHARS = 16 * 1024;
const HTTP_TIMEOUT_MS = 15_000;

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** Crude tag-strip for summaries (not a parser — summaries are evidence hints). */
function stripMarkup(body: string): string {
  return body
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
}

/** Default runtime fetcher backed by global `fetch` (never used in tests). */
export function createHttpResearchFetcher(timeoutMs: number = HTTP_TIMEOUT_MS): ResearchFetcher {
  return async (url, options) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onOuterAbort = (): void => controller.abort();
    options?.signal?.addEventListener('abort', onOuterAbort, { once: true });
    try {
      const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
      const body = await response.text();
      return { status: response.status, body };
    } finally {
      clearTimeout(timer);
      options?.signal?.removeEventListener('abort', onOuterAbort);
    }
  };
}

/** Create the configured-documentation-URLs adapter. */
export function createDocumentationAdapter(
  options: DocumentationAdapterOptions,
): ResearchSourceAdapter {
  const urls = options.urls.filter((url) => url.trim().length > 0);
  const maxBodyChars = options.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS;
  const fetcher = options.fetcher;

  const detectSetup = (): Promise<ResearchAdapterSetup> => {
    if (urls.length === 0 || fetcher === undefined) {
      return Promise.resolve({
        configured: false,
        requiresCredentials: false,
        credentialsPresent: true,
        detail:
          urls.length === 0
            ? 'No documentation URLs are configured (set SF_RESEARCH_DOC_URLS).'
            : 'No documentation fetcher is available on this runtime.',
        setupAction: {
          id: 'research.docs',
          title: 'Configure documentation sources',
          description:
            'Set SF_RESEARCH_DOC_URLS to a comma-separated list of documentation URLs to include documentation research.',
        },
      });
    }
    return Promise.resolve({
      configured: true,
      requiresCredentials: false,
      credentialsPresent: true,
    });
  };

  const discover = (
    _context: ResearchRunContext,
    discoverOptions: DiscoverOptions,
  ): Promise<readonly DiscoveredSource[]> =>
    Promise.resolve(
      urls.slice(0, Math.max(discoverOptions.limit, 0)).map((url, index) => ({
        sourceId: `docs:${index + 1}`,
        kind: 'documentation' as const,
        title: url,
        locator: url,
        summary: `Configured documentation URL ${url}`,
      })),
    );

  const read = async (
    source: DiscoveredSource,
    readOptions: ReadOptions,
  ): Promise<SourceReadResult> => {
    if (fetcher === undefined || source.locator === undefined) {
      throw new Error(`Documentation source "${source.sourceId}" has no fetcher/locator.`);
    }
    const result = await fetcher(source.locator, { signal: readOptions.signal });
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`Documentation fetch for ${source.locator} returned HTTP ${result.status}.`);
    }
    const text = stripMarkup(result.body).slice(0, maxBodyChars);
    return {
      summary: `Documentation ${source.locator}: ${clip(text, 240)}`,
      contentDigest: sha256(result.body),
      findings: [
        {
          statement: `Documentation source ${source.locator}${result.title !== undefined ? ` ("${result.title}")` : ''} says: ${clip(text, 200)}`,
          classification: 'verified_fact',
          confidence: 0.8,
          reusable: true,
          knowledgeKind: 'source',
          tags: ['documentation'],
        },
      ],
    };
  };

  return { id: 'docs', kind: 'documentation', detectSetup, discover, read };
}

/* ----------------------------------------------------------------------------
 * Web-search provider hook
 * ------------------------------------------------------------------------- */

/** One result from an external web-search provider. */
export interface WebSearchResultItem {
  readonly title: string;
  readonly url: string;
  readonly snippet?: string;
}

/** Setup state a web-search provider reports (presence only — never values). */
export interface WebSearchProviderSetup {
  readonly credentialsPresent: boolean;
  readonly setupAction?: SetupAction;
  readonly detail?: string;
}

/**
 * The external web/search provider contract. U2 ships the HOOK; a concrete
 * provider is configuration-dependent and may be injected by later units.
 */
export interface WebSearchProvider {
  readonly id: string;
  /** Report credential PRESENCE without exposing values (hardening E5). */
  detectSetup(): Promise<WebSearchProviderSetup>;
  search(
    query: string,
    options: { readonly limit: number; readonly signal?: AbortSignal },
  ): Promise<readonly WebSearchResultItem[]>;
}

/** Options for the web-search adapter. */
export interface WebSearchAdapterOptions {
  /** The configured provider; absent = fail closed (setup required). */
  readonly provider?: WebSearchProvider;
}

const MISSING_PROVIDER_ACTION: SetupAction = {
  id: 'research.search_provider',
  title: 'Configure a web-search provider',
  description:
    'Set SF_RESEARCH_SEARCH_PROVIDER and its credentials (e.g. SF_RESEARCH_SEARCH_API_KEY) to enable web-search research. Credential values are never recorded as evidence.',
};

/** Create the web-search adapter around an (optional) provider hook. */
export function createWebSearchAdapter(
  options: WebSearchAdapterOptions = {},
): ResearchSourceAdapter {
  const provider = options.provider;

  const detectSetup = async (): Promise<ResearchAdapterSetup> => {
    if (provider === undefined) {
      return {
        configured: false,
        requiresCredentials: true,
        credentialsPresent: false,
        detail: 'No web-search provider is configured on this runtime.',
        setupAction: MISSING_PROVIDER_ACTION,
      };
    }
    const setup = await provider.detectSetup();
    return {
      configured: true,
      requiresCredentials: true,
      credentialsPresent: setup.credentialsPresent,
      detail: setup.detail,
      setupAction:
        setup.setupAction ?? (setup.credentialsPresent ? undefined : MISSING_PROVIDER_ACTION),
    };
  };

  const discover = async (
    context: ResearchRunContext,
    discoverOptions: DiscoverOptions,
  ): Promise<readonly DiscoveredSource[]> => {
    if (provider === undefined) {
      throw new Error('No web-search provider is configured.');
    }
    const results = await provider.search(context.objective, {
      limit: Math.max(discoverOptions.limit, 0),
      signal: discoverOptions.signal,
    });
    return results.slice(0, Math.max(discoverOptions.limit, 0)).map((result, index) => ({
      sourceId: `web:${index + 1}`,
      kind: 'web_search' as const,
      title: result.title,
      locator: result.url,
      summary: result.snippet,
    }));
  };

  const read = (source: DiscoveredSource, _options: ReadOptions): Promise<SourceReadResult> => {
    // Search results are snippet-grade evidence: recorded as INFERENCE until a
    // documentation fetch verifies the page content.
    const snippet = source.summary ?? '(no snippet provided)';
    return Promise.resolve({
      summary: `Web search result ${source.locator ?? source.sourceId}: ${clip(snippet, 240)}`,
      contentDigest: sha256(snippet),
      findings: [
        {
          statement: `Web result "${source.title ?? source.sourceId}" suggests: ${clip(snippet, 200)}`,
          classification: 'inference',
          confidence: 0.5,
        },
      ],
    });
  };

  return { id: 'web-search', kind: 'web_search', detectSetup, discover, read };
}
