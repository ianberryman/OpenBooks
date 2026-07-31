import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useIsCompact } from './use-viewport';

/**
 * `matchMedia` is absent from jsdom (see `src/test/setup.ts`, which stubs only what Radix
 * reaches). The hook is specified to treat that absence as the regular tier, and to follow
 * a live `change` event otherwise — so the test installs a controllable `matchMedia` and
 * drives it, rather than asserting geometry jsdom cannot produce.
 */

type Listener = (event: Pick<MediaQueryListEvent, 'matches'>) => void;

function installMatchMedia(initialMatches: boolean): {
  emit: (matches: boolean) => void;
} {
  let matches = initialMatches;
  const listeners = new Set<Listener>();

  window.matchMedia = (): MediaQueryList =>
    ({
      get matches() {
        return matches;
      },
      media: '(max-width: 47.99rem)',
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
        listeners.add(listener as unknown as Listener);
      },
      removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
        listeners.delete(listener as unknown as Listener);
      },
      dispatchEvent: () => false,
    }) as MediaQueryList;

  return {
    emit: (next: boolean) => {
      matches = next;
      for (const listener of listeners) {
        listener({ matches: next });
      }
    },
  };
}

describe('useIsCompact', () => {
  afterEach(() => {
    // Remove the per-test stub so the absence-path test below sees a genuinely missing API.
    Reflect.deleteProperty(window, 'matchMedia');
    vi.restoreAllMocks();
  });

  it('is false (regular tier) when matchMedia is unavailable', () => {
    Reflect.deleteProperty(window, 'matchMedia');
    const { result } = renderHook(() => useIsCompact());
    expect(result.current).toBe(false);
  });

  it('reads the initial match', () => {
    installMatchMedia(true);
    const { result } = renderHook(() => useIsCompact());
    expect(result.current).toBe(true);
  });

  it('re-renders when the viewport crosses the boundary', () => {
    const media = installMatchMedia(false);
    const { result } = renderHook(() => useIsCompact());
    expect(result.current).toBe(false);

    act(() => {
      media.emit(true);
    });
    expect(result.current).toBe(true);

    act(() => {
      media.emit(false);
    });
    expect(result.current).toBe(false);
  });
});
