/**
 * PRD source adapter (full-factory U2).
 *
 * Covers two honest shapes of PRD input:
 *  - uploaded PRD TEXT: read deterministically (digest + heading extraction —
 *    no model in the loop, no fabrication), and
 *  - PRD REFERENCE metadata only (a `prdRef` without uploaded content): the
 *    reference is surfaced as a source, but reading it records an explicit GAP
 *    ("content not available") instead of pretending the file was read.
 */
import { createHash } from 'node:crypto';
import type {
  DiscoverOptions,
  DiscoveredSource,
  ReadOptions,
  ResearchAdapterSetup,
  ResearchFindingDraft,
  ResearchRunContext,
  ResearchSourceAdapter,
  SourceReadResult,
} from './research-contract';

/** Options for the PRD adapter (usually sourced from `run.created`). */
export interface PrdAdapterOptions {
  readonly prdText?: string;
  readonly prdRef?: string;
  /** Max headings extracted as findings from uploaded PRD text (default 5). */
  readonly maxHeadings?: number;
}

const PRD_TEXT_SOURCE_ID = 'prd:text';
const PRD_REF_SOURCE_ID = 'prd:ref';
const DEFAULT_MAX_HEADINGS = 5;

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function headingFindings(prdText: string, maxHeadings: number): ResearchFindingDraft[] {
  const headings = prdText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^#{1,6}\s+\S/.test(line))
    .slice(0, maxHeadings);
  if (headings.length === 0) {
    const firstLine = prdText
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    return firstLine === undefined
      ? []
      : [
          {
            statement: `The uploaded PRD begins: ${clip(firstLine, 160)}`,
            classification: 'verified_fact',
            confidence: 0.95,
            reusable: true,
            tags: ['prd'],
          },
        ];
  }
  return headings.map((heading) => ({
    statement: `PRD section: ${clip(heading.replace(/^#{1,6}\s+/, ''), 160)}`,
    classification: 'verified_fact' as const,
    confidence: 0.95,
    reusable: true,
    tags: ['prd'],
  }));
}

/** Create the PRD adapter. Not configured when the run carries no PRD input. */
export function createPrdAdapter(options: PrdAdapterOptions = {}): ResearchSourceAdapter {
  const prdText =
    options.prdText !== undefined && options.prdText.length > 0 ? options.prdText : undefined;
  const prdRef =
    options.prdRef !== undefined && options.prdRef.length > 0 ? options.prdRef : undefined;
  const maxHeadings = options.maxHeadings ?? DEFAULT_MAX_HEADINGS;

  const detectSetup = (): Promise<ResearchAdapterSetup> =>
    Promise.resolve(
      prdText !== undefined || prdRef !== undefined
        ? { configured: true, requiresCredentials: false, credentialsPresent: true }
        : {
            configured: false,
            requiresCredentials: false,
            credentialsPresent: true,
            detail: 'No PRD text or PRD reference was provided for this run.',
          },
    );

  const discover = (
    _context: ResearchRunContext,
    discoverOptions: DiscoverOptions,
  ): Promise<readonly DiscoveredSource[]> => {
    const sources: DiscoveredSource[] = [];
    if (prdText !== undefined) {
      sources.push({
        sourceId: PRD_TEXT_SOURCE_ID,
        kind: 'uploaded_prd',
        title: 'Uploaded PRD text',
        locator: prdRef,
        summary: `Uploaded PRD text (${prdText.length} characters).`,
      });
    } else if (prdRef !== undefined) {
      sources.push({
        sourceId: PRD_REF_SOURCE_ID,
        kind: 'uploaded_prd',
        title: 'PRD reference (metadata only)',
        locator: prdRef,
        summary: `PRD reference "${prdRef}" was provided without uploaded content.`,
      });
    }
    return Promise.resolve(sources.slice(0, Math.max(discoverOptions.limit, 0)));
  };

  const read = (source: DiscoveredSource, _options: ReadOptions): Promise<SourceReadResult> => {
    if (source.sourceId === PRD_TEXT_SOURCE_ID && prdText !== undefined) {
      return Promise.resolve({
        summary: `Uploaded PRD (${prdText.length} chars): ${clip(prdText, 240)}`,
        contentDigest: sha256(prdText),
        findings: headingFindings(prdText, maxHeadings),
      });
    }
    if (source.sourceId === PRD_REF_SOURCE_ID && prdRef !== undefined) {
      // Reference metadata only: no content to read — record an explicit gap
      // instead of fabricating a summary of a document we never saw.
      return Promise.resolve({
        summary: `PRD reference "${prdRef}" — metadata only, content not uploaded.`,
        gaps: [
          {
            question: `PRD reference "${prdRef}" was provided but its content is not available to research. Upload the PRD text or materialize the referenced file.`,
            impact: 'Planning proceeds without the PRD requirements it references.',
            blocking: false,
          },
        ],
      });
    }
    return Promise.reject(new Error(`Unknown PRD source "${source.sourceId}".`));
  };

  return { id: 'prd', kind: 'uploaded_prd', detectSetup, discover, read };
}
