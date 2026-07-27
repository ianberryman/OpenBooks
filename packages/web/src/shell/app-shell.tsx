import type { ReactElement, ReactNode } from 'react';
import { NavLink } from 'react-router-dom';

import { Button } from '../components/button';
import { cx } from '../lib/cx';
import { useTheme } from '../theme/theme';

/**
 * The layout frame: a header carrying the brand, the org indicator, and primary
 * navigation; a content area below it.
 *
 * **No screen lives here.** Auth, chart of accounts, contacts, settings, the journal
 * editor, and the reports are OB-047 through OB-052. What this owns is the frame those
 * six mount into, so that none of them has to render a header and they cannot render six
 * different ones.
 *
 * Two things are *slots* rather than content, because the shell must not acquire a
 * dependency on the API to render:
 *
 * - `orgIndicator` — the active organization, and eventually the switcher. It is spec §5's
 *   most consequential control (switching clears the query cache wholesale — see
 *   `src/query/client.ts`), so it belongs to OB-047 where the session exists. A shell that
 *   fetched the org itself would need a session before it could draw a login screen.
 * - `nav` — the primary destinations. D-25 makes the visible affordances follow the
 *   caller's permission set, which is `GET /v1/me` and therefore OB-047. Passing the items
 *   in keeps that filtering in one place instead of inside this component, where every
 *   future item would have to remember it.
 */
export interface NavItem {
  readonly to: string;
  readonly label: string;
}

export interface AppShellProps {
  readonly nav?: readonly NavItem[];
  readonly orgIndicator?: ReactNode;
  readonly children: ReactNode;
}

export function AppShell({ nav = [], orgIndicator, children }: AppShellProps): ReactElement {
  return (
    <div className="flex min-h-screen flex-col bg-canvas text-text">
      {/* Skip link: the header holds the org switcher and every primary destination, so a
          keyboard user reaches the content past all of it on every navigation. */}
      <a
        href="#main"
        className={cx(
          'sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50',
          'focus:rounded-md focus:border focus:border-border focus:bg-surface focus:px-3 focus:py-2',
        )}
      >
        Skip to content
      </a>

      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex h-14 w-full max-w-content items-center gap-4 px-4">
          <span className="font-semibold tracking-tight text-text">OpenBooks</span>

          <nav aria-label="Primary" className="flex items-center gap-1">
            {nav.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  cx(
                    'rounded-md px-2 py-1 text-base transition-colors',
                    isActive
                      ? 'bg-surface-selected font-medium text-text'
                      : 'text-text-muted hover:bg-surface-hover hover:text-text',
                  )
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-2">
            {orgIndicator}
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main id="main" className="mx-auto w-full max-w-content flex-1 px-4 py-6">
        {children}
      </main>
    </div>
  );
}

/**
 * Lives in the shell rather than in a settings screen because it is the only control that
 * has to be reachable before there is a session — a login form is rendered in whichever
 * theme the user needs to read it.
 */
function ThemeToggle(): ReactElement {
  const { theme, setTheme } = useTheme();
  const next = theme === 'dark' ? 'light' : 'dark';

  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label={`Switch to ${next} theme`}
      onClick={() => {
        setTheme(next);
      }}
    >
      <span aria-hidden>{theme === 'dark' ? '☾' : '☀'}</span>
    </Button>
  );
}
