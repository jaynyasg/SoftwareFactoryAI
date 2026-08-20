/**
 * Shared adapter-catalog env resolution. One module feeds every entry point
 * (Next mount, standalone/hosted server, app-level default), so the hosted
 * daemon can never again silently drop SF_CLAUDE_ALLOWED_SKILLS.
 */
import { describe, expect, it } from 'vitest';
import {
  resolveAdapterCatalogOptions,
  resolveClaudeAllowedSkills,
  resolvePreferredSkills,
} from '../../src/server/adapter-env';

describe('resolveClaudeAllowedSkills', () => {
  it('fails closed: unset or empty means NO skills', () => {
    expect(resolveClaudeAllowedSkills({})).toEqual([]);
    expect(resolveClaudeAllowedSkills({ SF_CLAUDE_ALLOWED_SKILLS: '   ' })).toEqual([]);
  });

  it('parses the wildcard and comma lists (trimming empties)', () => {
    expect(resolveClaudeAllowedSkills({ SF_CLAUDE_ALLOWED_SKILLS: '*' })).toEqual(['*']);
    expect(resolveClaudeAllowedSkills({ SF_CLAUDE_ALLOWED_SKILLS: 'a, b ,, c ' })).toEqual([
      'a',
      'b',
      'c',
    ]);
  });
});

describe('resolvePreferredSkills', () => {
  it('reads SF_PREFERRED_SKILLS with the legacy SF_CLAUDE_PREFERRED_SKILLS fallback', () => {
    expect(resolvePreferredSkills({ SF_PREFERRED_SKILLS: 'x,y' })).toEqual(['x', 'y']);
    expect(resolvePreferredSkills({ SF_CLAUDE_PREFERRED_SKILLS: 'legacy' })).toEqual(['legacy']);
    expect(
      resolvePreferredSkills({ SF_PREFERRED_SKILLS: 'new', SF_CLAUDE_PREFERRED_SKILLS: 'old' }),
    ).toEqual(['new']);
    expect(resolvePreferredSkills({})).toEqual([]);
  });
});

describe('resolveAdapterCatalogOptions', () => {
  it('bundles both knobs for createDefaultAdapterCatalog', () => {
    expect(
      resolveAdapterCatalogOptions({
        SF_CLAUDE_ALLOWED_SKILLS: 'software-factory-conventions',
        SF_PREFERRED_SKILLS: 'software-factory-conventions',
      }),
    ).toEqual({
      claudeAllowedSkills: ['software-factory-conventions'],
      preferredSkills: ['software-factory-conventions'],
    });
  });
});
