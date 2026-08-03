import type { NavItem, NavSection } from './app-shell';

/**
 * The primary destinations, grouped into the sections the sidebar renders.
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
 *
 * ## Grouping (nav consolidation, Phase 1)
 *
 * Twenty-nine flat links do not fit a bar; grouped into eight domain sections they fit a
 * sidebar. A section's `header`, when present, is the section's own screen — so the section
 * title is itself a link (`Sales` → `/sales`) rather than a label repeated by a child. A
 * section with no `header` (Accounting, Automation) is a pure category whose title is inert.
 * Filtering is unchanged and still per-leaf: a section renders when its header or any child
 * survives the permission filter, and drops out entirely when none do.
 */
interface PermissionedNavItem extends NavItem {
  readonly permission: string;
}

interface NavGroup {
  readonly label: string;
  /** When set, the section title links to the section's own screen (D-25 filter applies). */
  readonly header?: PermissionedNavItem;
  readonly children: readonly PermissionedNavItem[];
}

const NAV_GROUPS: readonly NavGroup[] = [
  {
    label: 'Sales',
    header: { to: '/sales', label: 'Sales', permission: 'invoices.read' },
    children: [
      { to: '/estimates', label: 'Estimates', permission: 'estimates.read' },
      // Both recurring templates and dunning policies read on `invoices.read`; their writes
      // want `invoices.write`/`invoices.send`, but naming those would hide the link from a
      // caller who can legitimately view the schedule or the ladder — the D-25 reasoning the
      // whole file rests on: drop links that always fail, not links whose every action
      // succeeds. The service enforces the write codes and the screen surfaces the refusal.
      { to: '/recurring-invoices', label: 'Recurring invoices', permission: 'invoices.read' },
      { to: '/dunning', label: 'Dunning', permission: 'invoices.read' },
    ],
  },
  {
    label: 'Purchases',
    header: { to: '/purchases', label: 'Purchases', permission: 'bills.read' },
    children: [
      { to: '/purchase-orders', label: 'Purchase orders', permission: 'purchase_orders.read' },
      { to: '/expenses', label: 'Expenses', permission: 'expenses.read' },
      // `bills.read`: the capture review screen reads on it; its writes (upload, create-draft)
      // want `bills.write`, but naming that would hide the link from a caller who can view the
      // review queue (D-25, initiative O).
      { to: '/bill-captures', label: 'Bill capture', permission: 'bills.read' },
      /**
       * `pending_payments.read` (OB-116, initiative PB) for both Pay Bills and Disbursements —
       * the service is the real gate (`buildPendingPayment`, `issuePendingPayment`,
       * `cancelPendingPayment` each enforce their own release-authority permission per D-109),
       * and this filter only drops a link that would always fail to load its queue.
       */
      { to: '/pay-bills', label: 'Pay bills', permission: 'pending_payments.read' },
      { to: '/disbursements', label: 'Disbursements', permission: 'pending_payments.read' },
    ],
  },
  {
    label: 'Banking',
    /**
     * `banking.read`, the one code every banking screen enforces for its reads (M4). The
     * section's writes want `banking.import`/`banking.match`/`banking.reconcile`, but naming a
     * write code here would hide the link from a `read_only` caller who can legitimately view
     * imports, proposals and reconciliations (D-25).
     */
    header: { to: '/banking', label: 'Banking', permission: 'banking.read' },
    children: [
      /**
       * `payments_received.read`: the screen opens on the payments list, and an *unfiltered*
       * list spans both subledgers, so the service also asks for `payments_made.read`. Naming
       * the stricter pair here would hide the link from an AR clerk who can use most of the
       * screen; the service refuses the unfiltered list and the screen surfaces that (D-25).
       */
      { to: '/money', label: 'Money', permission: 'payments_received.read' },
      /**
       * `banking.read`, the read half `bank-feeds/connections.service.ts` enforces for every
       * `GET` on this surface (OB-227); connecting and disconnecting want `banking.connect` and
       * a manual sync wants `banking.import`, but naming a write code here would hide the link
       * from a caller who can legitimately view the connections (D-25).
       */
      { to: '/bank-feeds', label: 'Bank feeds', permission: 'banking.read' },
      /**
       * `processing.read`, the read half `connections.service.ts` enforces for every `GET` on
       * this surface (OB-151); the write actions want `processing.write` (D-25).
       */
      { to: '/processing', label: 'Payment processing', permission: 'processing.read' },
    ],
  },
  {
    label: 'Accounting',
    children: [
      { to: '/accounts', label: 'Accounts', permission: 'accounts.read' },
      { to: '/journal-entry', label: 'Journal entry', permission: 'journals.read' },
      // OB-236: the posted-journals list — the read-and-navigate surface that makes an
      // already-posted entry reachable again (and so reversible from the UI).
      { to: '/journals', label: 'Journals', permission: 'journals.read' },
      // Initiative L: recurring GL templates read on their own key (D-117, no SoD); the
      // service enforces `recurring_journals.write` and the screen surfaces the refusal.
      {
        to: '/recurring-journals',
        label: 'Recurring journals',
        permission: 'recurring_journals.read',
      },
      { to: '/fixed-assets', label: 'Fixed assets', permission: 'fixed_assets.read' },
      { to: '/inventory', label: 'Inventory', permission: 'inventory.read' },
    ],
  },
  {
    label: 'Reports',
    header: { to: '/reports', label: 'Reports', permission: 'reports.read' },
    children: [
      /**
       * `reports.read` (initiative P, OB-195): a statement package stitches together the same
       * three reports that permission already gates into one branded PDF, so it needs no
       * permission those reports do not (`statement-packages.ts`'s own module header).
       */
      { to: '/statement-packages', label: 'Statement packages', permission: 'reports.read' },
      /**
       * `reports.read` (OB-220): a customer statement is the AR aging report scoped to one
       * customer, rendered branded and optionally emailed — it needs no permission that
       * report does not (`account-statement.service.ts`'s own module header).
       */
      { to: '/customer-statements', label: 'Customer statements', permission: 'reports.read' },
      { to: '/budgets', label: 'Budgets', permission: 'budgets.read' },
      // 1099 contractor tax reporting (OB-228): the worksheet, vendor W-9/TIN setup, and
      // filing runs. `ten99.read` — its own key, PII-gated, distinct from `reports.read`.
      { to: '/ten99', label: '1099 Center', permission: 'ten99.read' },
    ],
  },
  {
    label: 'Contacts',
    header: { to: '/contacts', label: 'Contacts', permission: 'contacts.read' },
    children: [],
  },
  {
    label: 'Automation',
    children: [
      { to: '/agent-proposals', label: 'Agent proposals', permission: 'agents.review' },
      /**
       * `workflows.read` (initiative Q) for both Automations and the Work queue: gates viewing
       * an automation's composition and what its `agent_task` actions have enqueued. Composing
       * wants `workflows.write` and activate/deactivate/run want `workflows.activate`
       * (owner-only), but naming either here would hide the link from a caller who can view
       * what exists without being able to change it (D-25).
       */
      { to: '/automations', label: 'Automations', permission: 'workflows.read' },
      { to: '/work-items', label: 'Work queue', permission: 'workflows.read' },
    ],
  },
  {
    label: 'Settings',
    // `orgs.read` and not the union of dimensions/members/periods: the settings screen is the
    // organization's own administration, and the seeded roles that hold any of its parts hold
    // this one too — except the job-scoped ones (`ap_only`, `ar_only`), for whom the whole
    // section is somebody else's work.
    header: { to: '/settings', label: 'Settings', permission: 'orgs.read' },
    children: [
      /**
       * `accounts.write`: the cutover's primary write is creating the chart, and naming the
       * narrower permission here — rather than a would-be `imports.write` the server does not
       * have — hides the link from a caller who could not do the one thing that always has to
       * happen for this screen to matter (Phase 3, the QuickBooks migration gate).
       */
      { to: '/quickbooks-import', label: 'Import from QuickBooks', permission: 'accounts.write' },
      /**
       * `roles.read`: the custom-role builder (OB-226). The seeded roles that can view roles
       * (owner, bookkeeper, read-only, approver, accountant) see the link; only `owner` holds
       * `roles.write` and can actually compose one, but the screen is a viewer for the rest.
       */
      { to: '/roles', label: 'Roles', permission: 'roles.read' },
      /**
       * `api_keys.read`, `integrations.read` (twice) and `agents.review` were OB-105's
       * management screens, each gated on the read half of the permission its own writes sit
       * under (D-25). `/oauth/consent` gets no entry anywhere — it is reached only by the 302
       * `GET /oauth/authorize` sends a logged-in user to, never typed or linked.
       */
      { to: '/api-keys', label: 'API keys', permission: 'api_keys.read' },
      { to: '/oauth-clients', label: 'OAuth clients', permission: 'integrations.read' },
      { to: '/connected-apps', label: 'Connected apps', permission: 'integrations.read' },
    ],
  },
];

export function visibleNavSections(permissions: ReadonlySet<string>): readonly NavSection[] {
  const sections: NavSection[] = [];
  for (const group of NAV_GROUPS) {
    const headerVisible = group.header !== undefined && permissions.has(group.header.permission);
    const items = group.children
      .filter((child) => permissions.has(child.permission))
      .map(({ to, label }) => ({ to, label }));
    if (!headerVisible && items.length === 0) continue;
    sections.push({
      label: group.label,
      ...(headerVisible && group.header !== undefined ? { to: group.header.to } : {}),
      items,
    });
  }
  return sections;
}

/**
 * Where `/` sends the caller.
 *
 * A landing choice, not an authorization one: it picks which of the visible destinations to
 * open first and forbids nothing. The Chart of accounts has always been the signed-in home
 * (it was the first flat nav item), so a caller who can reach it lands there regardless of
 * how the sidebar sections are now ordered — decoupling the landing from section order rather
 * than pinning it to whichever domain happens to sit first. Anyone without `accounts.read`
 * (a job-scoped role) lands on their first visible destination instead, and an empty
 * permission set falls back to `/accounts` so the frame shows the service's own refusal
 * rather than nothing.
 */
export function landingPath(sections: readonly NavSection[]): string {
  const destinations = sections.flatMap((section) => [
    ...(section.to !== undefined ? [section.to] : []),
    ...section.items.map((item) => item.to),
  ]);
  if (destinations.includes('/accounts')) return '/accounts';
  return destinations[0] ?? '/accounts';
}
