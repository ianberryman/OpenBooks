import * as DialogPrimitive from '@radix-ui/react-dialog';
import type { ReactElement, ReactNode } from 'react';
import { useState } from 'react';
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

/**
 * A sidebar section (nav consolidation, Phase 1). `to` is present when the section title is
 * itself a destination — the section's own screen — so it renders as a link; absent, the
 * title is an inert category heading. `items` are the surviving child links.
 */
export interface NavSection {
  readonly label: string;
  readonly to?: string;
  readonly items: readonly NavItem[];
}

export interface AppShellProps {
  readonly nav?: readonly NavSection[];
  readonly orgIndicator?: ReactNode;
  readonly children: ReactNode;
}

/** One primary destination, shared by section headers and their children. */
function NavRowLink({
  to,
  label,
  onNavigate,
}: NavItem & { onNavigate?: (() => void) | undefined }): ReactElement {
  return (
    <NavLink
      to={to}
      onClick={onNavigate}
      className={({ isActive }) =>
        cx(
          // `min-h-[44px]` — the compact-viewport touch target floor (Initiative R
          // acceptance). It only raises the row on touch-sized rendering; the `py-1.5`
          // keeps the visual density on desktop where the pointer is precise.
          'flex min-h-[44px] items-center rounded-md px-3 py-1.5 text-base transition-colors md:min-h-0',
          isActive
            ? 'bg-surface-selected font-medium text-text'
            : 'text-text-muted hover:bg-surface-hover hover:text-text',
        )
      }
    >
      {label}
    </NavLink>
  );
}

/**
 * The primary-navigation list. Extracted (Initiative R, OB-212) so the static sidebar and
 * the compact drawer render *identical* markup from one source — the grouped sections the
 * nav consolidation shipped cannot drift between the two presentations. `onNavigate` lets
 * the drawer close itself when a link is followed; the static sidebar passes nothing.
 */
function NavList({
  nav,
  onNavigate,
}: {
  readonly nav: readonly NavSection[];
  readonly onNavigate?: (() => void) | undefined;
}): ReactElement {
  return (
    <ul className="flex flex-col gap-4">
      {nav.map((section) => (
        <li key={section.label}>
          {section.to !== undefined ? (
            <NavRowLink to={section.to} label={section.label} onNavigate={onNavigate} />
          ) : (
            <span className="block px-3 py-1 text-sm font-semibold tracking-wide text-text-subtle uppercase">
              {section.label}
            </span>
          )}
          {section.items.length > 0 && (
            <ul className="mt-0.5 flex flex-col gap-0.5 pl-2">
              {section.items.map((item) => (
                <li key={item.to}>
                  <NavRowLink to={item.to} label={item.label} onNavigate={onNavigate} />
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}

export function AppShell({ nav = [], orgIndicator, children }: AppShellProps): ReactElement {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const hasNav = nav.length > 0;

  return (
    <div className="flex h-screen flex-col bg-canvas text-text">
      {/* Skip link: the sidebar holds every primary destination, so a keyboard user reaches
          the content past all of it on every navigation. */}
      <a
        href="#main"
        className={cx(
          'sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50',
          'focus:rounded-md focus:border focus:border-border focus:bg-surface focus:px-3 focus:py-2',
        )}
      >
        Skip to content
      </a>

      {/* Full width — the desktop app fills the screen rather than centring on `max-w-content`. */}
      <header className="shrink-0 border-b border-border bg-surface">
        <div className="flex h-14 w-full items-center gap-2 px-4 md:gap-4">
          {/* The compact-viewport nav entry point (OB-212). `md:hidden` removes both the
              trigger and — because the drawer content carries it too — the whole off-canvas
              nav on desktop, where the static sidebar below is the navigation. The drawer is
              a Radix Dialog so the focus trap, Esc-to-close, scrim and scroll-lock are the
              same battle-tested primitive the app's other modals use, not a hand-rolled one. */}
          {hasNav && (
            <DialogPrimitive.Root open={drawerOpen} onOpenChange={setDrawerOpen}>
              <DialogPrimitive.Trigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Open navigation"
                  className="md:hidden"
                >
                  <span aria-hidden>☰</span>
                </Button>
              </DialogPrimitive.Trigger>
              <DialogPrimitive.Portal>
                <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-scrim md:hidden" />
                <DialogPrimitive.Content
                  aria-describedby={undefined}
                  className={cx(
                    'fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col overflow-y-auto',
                    'border-r border-border bg-surface px-3 py-4 shadow-overlay md:hidden',
                  )}
                >
                  <div className="mb-2 flex items-center justify-between px-3">
                    <DialogPrimitive.Title className="font-semibold tracking-tight text-text">
                      OpenBooks
                    </DialogPrimitive.Title>
                    <DialogPrimitive.Close asChild>
                      <Button variant="ghost" size="sm" aria-label="Close navigation">
                        <span aria-hidden>✕</span>
                      </Button>
                    </DialogPrimitive.Close>
                  </div>
                  <nav aria-label="Primary">
                    <NavList nav={nav} onNavigate={() => setDrawerOpen(false)} />
                  </nav>
                </DialogPrimitive.Content>
              </DialogPrimitive.Portal>
            </DialogPrimitive.Root>
          )}
          <span className="font-semibold tracking-tight text-text">OpenBooks</span>
          <div className="ml-auto flex items-center gap-2">
            {orgIndicator}
            <ThemeToggle />
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {hasNav && (
          <nav
            aria-label="Primary"
            className="hidden w-60 shrink-0 overflow-y-auto border-r border-border bg-surface px-3 py-4 md:block"
          >
            <NavList nav={nav} />
          </nav>
        )}

        <main id="main" className="min-w-0 flex-1 overflow-y-auto px-4 py-4 md:px-6 md:py-6">
          {children}
        </main>
      </div>
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
