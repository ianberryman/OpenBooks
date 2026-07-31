import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { ThemeProvider } from '../theme/theme';
import { AppShell } from './app-shell';
import type { NavSection } from './app-shell';

/**
 * Initiative R (OB-212). jsdom applies no CSS, so `md:hidden` hides nothing here and both
 * presentations of the nav are in the DOM — the static sidebar renders its links, and the
 * compact hamburger + drawer are reachable. The layout question (which one is *visible* at
 * a given width) is OB-219's real browser. What is answerable here is the behaviour the
 * drawer must have regardless of viewport: it opens from the hamburger, mounts the same
 * grouped links, and closes when one is followed — the traps a mouse-only reader misses.
 */
// `ThemeProvider` (rendered by the shell's theme toggle) reads the system colour scheme;
// jsdom has no `matchMedia`, so stub it as App.test.tsx does. Never compact — the toggle's
// query is the colour-scheme one, not the viewport one, and the drawer under test is CSS-gated.
window.matchMedia = (media: string): MediaQueryList =>
  ({
    media,
    matches: false,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }) as MediaQueryList;

const NAV: readonly NavSection[] = [
  {
    label: 'Sales',
    items: [
      { to: '/sales', label: 'Invoices' },
      { to: '/contacts', label: 'Contacts' },
    ],
  },
];

function renderShell(): void {
  render(
    <ThemeProvider>
      <MemoryRouter>
        <AppShell nav={NAV}>
          <p>content</p>
        </AppShell>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

describe('AppShell nav drawer', () => {
  it('opens the drawer from the hamburger and closes it when a link is followed', async () => {
    const user = userEvent.setup();
    renderShell();

    // Closed: only the static sidebar's copy of each link is mounted.
    expect(screen.getAllByRole('link', { name: 'Invoices' })).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Open navigation' }));

    // The drawer is a Radix dialog; its links are the second copy now on screen.
    const drawer = screen.getByRole('dialog', { name: 'OpenBooks' });
    expect(within(drawer).getByRole('link', { name: 'Contacts' })).toBeInTheDocument();

    // Following a link closes the drawer (its onNavigate), leaving one copy again.
    await user.click(within(drawer).getByRole('link', { name: 'Contacts' }));
    expect(screen.queryByRole('dialog', { name: 'OpenBooks' })).not.toBeInTheDocument();
  });

  it('closes the drawer on Escape', async () => {
    const user = userEvent.setup();
    renderShell();

    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    expect(screen.getByRole('dialog', { name: 'OpenBooks' })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'OpenBooks' })).not.toBeInTheDocument();
  });

  it('renders no nav chrome when there are no destinations', () => {
    render(
      <ThemeProvider>
        <MemoryRouter>
          <AppShell>
            <p>content</p>
          </AppShell>
        </MemoryRouter>
      </ThemeProvider>,
    );
    expect(screen.queryByRole('button', { name: 'Open navigation' })).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });
});
