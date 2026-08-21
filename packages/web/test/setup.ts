/**
 * Vitest setup shared by all web tests. Registers @testing-library/jest-dom
 * matchers (e.g. toBeInTheDocument, toHaveAccessibleName). The import only
 * extends `expect`; it is harmless in the node-env server tests, which never use
 * the DOM matchers.
 */
import '@testing-library/jest-dom/vitest';

// jsdom does not implement matchMedia; the responsive drawer hook needs it.
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}
