/**
 * Adapter catalog + selection (U6): run-settings resolution, setup-detection
 * ordering, and explainable not-ready outcomes. All adapters are fakes — no
 * real CLI is ever probed.
 */
import { describe, expect, it } from 'vitest';
import {
  AdapterError,
  createAdapterCatalog,
  createDefaultAdapterCatalog,
  selectExecutionAdapter,
} from '../../src/index';
import type { AdapterSetupState, ExecutionAdapter } from '../../src/index';

function fakeAdapter(id: string, setup: Partial<AdapterSetupState> = {}): ExecutionAdapter {
  return {
    id,
    family: 'codex',
    detectSetup: () =>
      Promise.resolve({
        available: setup.available ?? true,
        authenticated: setup.authenticated ?? true,
        capacity: setup.capacity ?? 4,
        setupActions: setup.setupActions,
        detail: setup.detail,
      }),
    execute: () =>
      Promise.resolve({ ok: false as const, error: AdapterError.unavailable('not used') }),
    reportCapacity: () => setup.capacity ?? 4,
  };
}

describe('createAdapterCatalog', () => {
  it('lists adapters in registration order and looks up by id', () => {
    const a = fakeAdapter('a');
    const b = fakeAdapter('b');
    const catalog = createAdapterCatalog([a, b]);
    expect(catalog.ids()).toEqual(['a', 'b']);
    expect(catalog.get('b')).toBe(b);
    expect(catalog.get('missing')).toBeUndefined();
  });

  it('rejects duplicate adapter ids', () => {
    expect(() => createAdapterCatalog([fakeAdapter('a'), fakeAdapter('a')])).toThrow(/duplicate/i);
  });

  it('the default catalog offers codex, claude, and the API stub in order', () => {
    expect(createDefaultAdapterCatalog().ids()).toEqual([
      'codex-cli',
      'claude-code-cli',
      'api-stub',
    ]);
  });
});

describe('selectExecutionAdapter', () => {
  it('resolves a ready run-settings selection', async () => {
    const catalog = createAdapterCatalog([fakeAdapter('a'), fakeAdapter('b')]);
    const selection = await selectExecutionAdapter(catalog, 'b');
    expect(selection.ready).toBe(true);
    expect(selection.adapter?.id).toBe('b');
    expect(selection.source).toBe('run_settings');
  });

  it('an unknown selected adapter is an explicit setup problem, never a fallback', async () => {
    const catalog = createAdapterCatalog([fakeAdapter('a')]);
    const selection = await selectExecutionAdapter(catalog, 'nope');
    expect(selection.ready).toBe(false);
    expect(selection.adapter).toBeUndefined();
    expect(selection.reason).toContain('"nope"');
    expect(selection.reason).toContain('a');
    expect(selection.requiredAction).toBeDefined();
    expect(selection.candidates).toEqual(['a']);
  });

  it('a selected adapter that fails its setup probe is not ready but explainable', async () => {
    const catalog = createAdapterCatalog([
      fakeAdapter('a', {
        available: true,
        authenticated: false,
        detail: 'no active session',
        setupActions: [{ id: 'a.login', title: 'Authenticate the CLI' }],
      }),
    ]);
    const selection = await selectExecutionAdapter(catalog, 'a');
    expect(selection.ready).toBe(false);
    expect(selection.adapter?.id).toBe('a');
    expect(selection.reason).toMatch(/unauthenticated/);
    expect(selection.requiredAction).toBe('Authenticate the CLI');
  });

  it('detection picks the FIRST ready adapter in catalog order', async () => {
    const catalog = createAdapterCatalog([
      fakeAdapter('down', { available: false, authenticated: false }),
      fakeAdapter('ready-1'),
      fakeAdapter('ready-2'),
    ]);
    const selection = await selectExecutionAdapter(catalog);
    expect(selection.ready).toBe(true);
    expect(selection.adapter?.id).toBe('ready-1');
    expect(selection.source).toBe('detected');
  });

  it('aggregates every candidate probe detail when nothing is ready', async () => {
    const catalog = createAdapterCatalog([
      fakeAdapter('x', { available: false, detail: 'not installed' }),
      fakeAdapter('y', { available: true, authenticated: false, detail: 'logged out' }),
    ]);
    const selection = await selectExecutionAdapter(catalog);
    expect(selection.ready).toBe(false);
    expect(selection.adapter?.id).toBe('x'); // representative candidate
    expect(selection.reason).toContain('x (unavailable: not installed)');
    expect(selection.reason).toContain('y (unauthenticated: logged out)');
    expect(selection.requiredAction).toContain('x, y');
  });

  it('an empty catalog fails closed with a configure action', async () => {
    const selection = await selectExecutionAdapter(createAdapterCatalog([]));
    expect(selection.ready).toBe(false);
    expect(selection.adapter).toBeUndefined();
    expect(selection.reason).toMatch(/no execution adapters/i);
  });

  it('folds a throwing setup probe into a not-ready state instead of throwing', async () => {
    const throwing: ExecutionAdapter = {
      id: 'boom',
      family: 'codex',
      detectSetup: () => Promise.reject(new Error('probe exploded')),
      execute: () =>
        Promise.resolve({ ok: false as const, error: AdapterError.unavailable('not used') }),
      reportCapacity: () => 0,
    };
    const selection = await selectExecutionAdapter(createAdapterCatalog([throwing]), 'boom');
    expect(selection.ready).toBe(false);
    expect(selection.reason).toContain('probe exploded');
  });
});
