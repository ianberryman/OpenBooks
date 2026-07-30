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
  // Both recurring templates and dunning policies read on `invoices.read`; their writes want
  // `invoices.write`/`invoices.send`, but naming those would hide the link from a caller who
  // can legitimately view the schedule or the ladder — the same D-25 reasoning as `/money`
  // and `/banking` above: this filter drops links that always fail, not links whose every
  // action succeeds. The service enforces the write codes and the screen surfaces the refusal.
  { to: '/recurring-invoices', label: 'Recurring invoices', permission: 'invoices.read' },
  { to: '/dunning', label: 'Dunning', permission: 'invoices.read' },
  { to: '/purchases', label: 'Purchases', permission: 'bills.read' },
  // `bills.read`, the same reasoning as the invoicing surfaces above: the capture
  // review screen reads on `bills.read`; its writes (upload, create-draft) want
  // `bills.write`, but naming that would hide the link from a caller who can view
  // the review queue. D-25 — the filter drops links that always fail, not links
  // whose every action succeeds; the service enforces the write code (initiative O).
  { to: '/bill-captures', label: 'Bill capture', permission: 'bills.read' },
  /**
   * `pending_payments.read` (OB-116, initiative PB) for both Pay Bills and Disbursements —
   * the same D-25 reasoning as every gate on this list: the service is the real gate
   * (`buildPendingPayment`, `issuePendingPayment`, `cancelPendingPayment` each enforce their
   * own release-authority permission per D-109), and this filter only drops a link that
   * would always fail to load its queue. A caller who can view the queue but not build,
   * issue or cancel still gets both links; the service refuses each write.
   */
  { to: '/pay-bills', label: 'Pay bills', permission: 'pending_payments.read' },
  { to: '/disbursements', label: 'Disbursements', permission: 'pending_payments.read' },
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
  /**
   * `processing.read`, the read half `connections.service.ts` enforces for every
   * `GET` on this surface (OB-151). The write actions — connect, deactivate, reactivate
   * — want `processing.write`, but naming that here would hide the link from a caller
   * who can legitimately view which processor an org has connected without being able
   * to change it, the same D-25 reasoning as `/banking` and `/money` above.
   */
  { to: '/processing', label: 'Payment processing', permission: 'processing.read' },
  { to: '/reports', label: 'Reports', permission: 'reports.read' },
  // `orgs.read` and not the union of dimensions/members/periods: the settings screen is the
  // organization's own administration, and the seeded roles that hold any of its parts hold
  // this one too — except the job-scoped ones (`ap_only`, `ar_only`), for whom the whole
  // screen is somebody else's work.
  { to: '/settings', label: 'Settings', permission: 'orgs.read' },
  /**
   * `accounts.write`, the same reasoning as `/banking` above: the cutover's primary write is
   * creating the chart, and naming the narrower permission here — rather than a would-be
   * `imports.write` the server does not have — hides the link from a caller who could not do
   * the one thing that always has to happen for this screen to do anything (Phase 3, the
   * QuickBooks migration gate).
   */
  { to: '/quickbooks-import', label: 'Import from QuickBooks', permission: 'accounts.write' },
  /**
   * `api_keys.read`, `integrations.read` (twice) and `agents.review` — OB-105's four
   * management screens, each gated on the read half of the permission its own writes sit
   * under, the same D-25 reasoning as everything above: a caller who can view keys,
   * clients or connected apps but not mint or revoke one still gets the link, and the
   * service refuses the write. `/oauth/consent` (`oauth-consent.tsx`) gets no entry here at
   * all — it is reached only by the 302 `GET /oauth/authorize` sends a logged-in user to,
   * never typed or linked, so a nav item for it would offer a page with no meaning to
   * arrive at cold.
   */
  { to: '/api-keys', label: 'API keys', permission: 'api_keys.read' },
  { to: '/oauth-clients', label: 'OAuth clients', permission: 'integrations.read' },
  { to: '/connected-apps', label: 'Connected apps', permission: 'integrations.read' },
  { to: '/agent-proposals', label: 'Agent proposals', permission: 'agents.review' },
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
