import type { ReactElement, ReactNode } from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

/**
 * The theme, as JavaScript sees it. CSS sees the same thing as `data-theme` on `<html>`,
 * and that attribute is the authority — see the commentary in `src/styles/tokens.css` for
 * why there is one hook rather than a hook and a media query.
 *
 * This module does not decide the *initial* theme. The inline script in `index.html` does,
 * before first paint, because a decision made here runs after it. What this owns is
 * changes: the toggle, persistence, and following the system preference for as long as the
 * user has not overridden it.
 */
export type Theme = 'light' | 'dark';

/** Spelled here and in the inline script in `index.html`, which runs before this bundle. */
const STORAGE_KEY = 'openbooks.theme';

const DARK_QUERY = '(prefers-color-scheme: dark)';

interface ThemeContextValue {
  readonly theme: Theme;
  /** `null` returns to following the system preference. */
  readonly setTheme: (theme: Theme | null) => void;
  /** True while no explicit choice is stored, so the toggle can say what it is doing. */
  readonly followsSystem: boolean;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function isTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark';
}

/**
 * Storage access is wrapped because a hardened browser profile throws on *read* as well as
 * write, and an accounting application that renders nothing because it could not remember
 * a colour scheme is a worse failure than the one it was guarding against.
 */
function readStoredTheme(): Theme | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isTheme(stored) ? stored : null;
  } catch {
    return null;
  }
}

function writeStoredTheme(theme: Theme | null): void {
  try {
    if (theme === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Nothing to do and nothing to report: the theme still applies for this session.
  }
}

function systemTheme(): Theme {
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
}

export function ThemeProvider({ children }: { readonly children: ReactNode }): ReactElement {
  const [stored, setStored] = useState<Theme | null>(readStoredTheme);
  const [system, setSystem] = useState<Theme>(systemTheme);

  /**
   * The system preference is watched rather than read once. A user on a machine that
   * switches at sunset has not made a choice about this application, so following the
   * change is the whole point of not having stored one.
   */
  useEffect(() => {
    const query = window.matchMedia(DARK_QUERY);
    const onChange = (event: MediaQueryListEvent): void => {
      setSystem(event.matches ? 'dark' : 'light');
    };
    query.addEventListener('change', onChange);
    return () => {
      query.removeEventListener('change', onChange);
    };
  }, []);

  const theme = stored ?? system;

  /**
   * Written to the DOM in an effect rather than during render: the attribute is state
   * outside React, and React may render speculatively. The inline script has already put
   * the right value there for the first paint, so this effect is a no-op on load and does
   * real work only on a change.
   */
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const setTheme = useCallback((next: Theme | null) => {
    writeStoredTheme(next);
    setStored(next);
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, setTheme, followsSystem: stored === null }),
    [theme, setTheme, stored],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (value === null) throw new Error('useTheme requires a <ThemeProvider> above it.');
  return value;
}
