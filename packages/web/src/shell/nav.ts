import type { NavItem } from './app-shell';

/**
 * The primary destinations, each paired with the permission that makes it worth offering.
 *
 * ## This filter is advisory and it is not the gate (D-25)
 *
 * What it buys is that the shell does not offer actions that always fail, which D-25 calls
 * out as the difference between an interface and an unusable one. What it must never be
 * mistaken for is enforcement, and the shape of the code is what keeps that honest: nothing
 * in `src/App.tsx` consults this list when it builds the route table. Every screen stays
 * mounted at its own path and reachable by typing the URL, so hiding an item removes a link
 * and denies nothing. The service refuses regardless — `requirePermission` is service-layer
 * and lint-enforced (spec §2.4, §5), and OB-054's matrix asserts every operation against
 * every seeded role there, where a hidden button proves nothing.
 *
 * If a route guard ever appears that reads these permissions, that is the moment the second
 * half of D-25's predicted failure has happened: a UI that gates well enough becomes a UI
 * someone trusts as the gate.
 *
 * The permission is a plain string, not a union: `GET /v1/auth/me` returns `string[]` because
 * `permissions.code` is `VARCHAR(64)` and the catalog is owned by the server
 * (`packages/server/src/modules/permissions/catalog.ts`). A typo here hides a link; it cannot
 * grant anything.
 */
export interface PermissionedNavItem extends NavItem {
  readonly permission: string;
}

export const NAV_ITEMS: readonly PermissionedNavItem[] = [
  { to: '/accounts', label: 'Accounts', permission: 'accounts.read' },
  { to: '/journal-entry', label: 'Journal entry', permission: 'journals.read' },
  { to: '/contacts', label: 'Contacts', permission: 'contacts.read' },
  { to: '/sales', label: 'Sales', permission: 'invoices.read' },
  { to: '/purchases', label: 'Purchases', permission: 'bills.read' },
  /**
   * `payments_received.read`, and the choice is not arbitrary: the screen opens on the
   * payments list, and an *unfiltered* list spans both subledgers, so the service asks for
   * `payments_made.read` as well. Naming the stricter pair here would hide the link from an
   * AR clerk who can legitimately use most of the screen, and naming neither would offer it
   * to someone holding no payment permission at all.
   *
   * That the link can therefore appear for a caller who will be refused the unfiltered list
   * is exactly what D-25 says this filter is for and not for: it removes links that always
   * fail, it does not promise that every action behind one succeeds. The service refuses,
   * and the screen surfaces that refusal.
   */
  { to: '/money', label: 'Money', permission: 'payments_received.read' },
  /**
   * `banking.read`, the one code every banking screen enforces for its reads (M4). The
   * section's writes want `banking.import`/`banking.match`/`banking.reconcile`, but naming a
   * write code here would hide the link from a `read_only` caller who can legitimately view
   * imports, proposals and reconciliations — the same reasoning as `/money` above, and what
   * D-25 says this filter is for: it drops links that always fail, not links whose every
   * action succeeds.
   */
  { to: '/banking', label: 'Banking', permission: 'banking.read' },
  { to: '/reports', label: 'Reports', permission: 'reports.read' },
  // `orgs.read` and not the union of dimensions/members/periods: the settings screen is the
  // organization's own administration, and the seeded roles that hold any of its parts hold
  // this one too — except the job-scoped ones (`ap_only`, `ar_only`), for whom the whole
  // screen is somebody else's work.
  { to: '/settings', label: 'Settings', permission: 'orgs.read' },
];

export function visibleNav(permissions: ReadonlySet<string>): readonly NavItem[] {
  return NAV_ITEMS.filter((item) => permissions.has(item.permission)).map(({ to, label }) => ({
    to,
    label,
  }));
}

/**
 * Where `/` sends the caller.
 *
 * A landing choice, not an authorization one: it picks which of the visible destinations to
 * open first and forbids nothing, and `/accounts` stays the answer when the permission set is
 * empty so that the fallback is a screen showing the service's own refusal rather than a
 * blank frame with no explanation in it.
 */
export function landingPath(nav: readonly NavItem[]): string {
  return nav[0]?.to ?? '/accounts';
}
