import { useSyncExternalStore } from 'react';

/**
 * Initiative R (D-120/D-121). The one place layout is allowed to branch in JavaScript
 * rather than in CSS. Tailwind's `md:` variant handles the vast majority of the responsive
 * work declaratively; this hook exists only for the handful of cases where a component must
 * render *structurally different* markup on a compact viewport — a drawer instead of a
 * static sidebar, a stack of cards instead of a table — which no class toggle can express.
 *
 * "Compact" is D-120's lower tier: below `md` (48rem / 768px), the same boundary the `md:`
 * utilities use, so the CSS and the JS branch flip at exactly the same width. The value is
 * the token `--ob-breakpoint-md`; it is written as a literal here for the reason
 * `tokens.css` explains at length — a media-query string cannot resolve a `var()`.
 *
 * `47.99rem` rather than `48rem` so the two tiers do not both match at exactly 768px:
 * `md:` is `min-width: 48rem`, so compact must stop just below it.
 */
const COMPACT_QUERY = '(max-width: 47.99rem)';

function subscribe(onChange: () => void): () => void {
  // jsdom (the component-test environment) and any pre-hydration render have no
  // `matchMedia`; there is nothing to subscribe to, and the snapshot below returns the
  // regular-tier default. This mirrors how `theme.tsx` guards its own `matchMedia` use.
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {};
  }
  const query = window.matchMedia(COMPACT_QUERY);
  query.addEventListener('change', onChange);
  return () => {
    query.removeEventListener('change', onChange);
  };
}

function getSnapshot(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia(COMPACT_QUERY).matches;
}

/** Regular tier (desktop) when there is no window to measure — the desktop-first default. */
function getServerSnapshot(): boolean {
  return false;
}

/**
 * `true` when the viewport is below `md` (D-120's compact tier). Tear-free via
 * `useSyncExternalStore`, and it re-renders on an actual viewport crossing rather than on
 * every resize.
 */
export function useIsCompact(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
