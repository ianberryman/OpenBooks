import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

/**
 * The jsdom environment for `packages/web` (OB-058).
 *
 * Testing Library registers its own `afterEach(cleanup)` only when `afterEach` is a
 * global, and this project runs vitest without `globals: true`. Without the explicit
 * registration below every rendered tree stays in the document, so `getByRole` sees the
 * options of five previous comboboxes and fails on ambiguity rather than on behaviour.
 */
afterEach(() => {
  cleanup();
});

/**
 * Browser APIs jsdom does not implement, each reached by Radix's positioning and pointer
 * handling rather than by anything in this repo. Verified absent rather than assumed: a
 * stub for something jsdom already provides would shadow the real implementation.
 *
 * They are stubs, not simulations, and nothing in the suite asserts on geometry — that is
 * the part jsdom cannot answer honestly, since every element's box is zero. Layout claims
 * belong to OB-055's real browser. What these unblock is the part that *is* answerable
 * here: which element holds focus, and what its ARIA attributes say.
 */
globalThis.ResizeObserver ??= class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
};

// Radix Select scrolls the checked item into view as it opens, and its trigger asks
// whether a pointer is captured to tell a click from a drag. A missing method throws
// before the listbox exists, so the failure names neither Radix nor jsdom.
Object.defineProperties(Element.prototype, {
  scrollIntoView: { value: () => {}, writable: true, configurable: true },
  hasPointerCapture: { value: () => false, writable: true, configurable: true },
  setPointerCapture: { value: () => {}, writable: true, configurable: true },
  releasePointerCapture: { value: () => {}, writable: true, configurable: true },
});
