import type { ReactElement } from 'react';
import { BrowserRouter, Navigate, Route, Routes, matchPath, useLocation } from 'react-router-dom';

import { permissionSet, useIdentity } from './auth/identity';
import type { CallerIdentity } from './auth/identity';
import { OrgSelectionScreen } from './auth/org-selection';
import { SignOutButton } from './auth/sign-out';
import { ErrorBanner } from './components';
import { AccountsScreen } from './screens/accounts';
import { AgentProposalsScreen } from './screens/agent-proposals';
import { ApiKeysScreen } from './screens/api-keys';
import { AuthScreen } from './screens/auth';
import { AutomationsScreen } from './screens/automations';
import { BankingScreen } from './screens/banking';
import { BillCapturesScreen } from './screens/bill-captures';
import { BudgetsScreen } from './screens/budgets';
import { ConnectedAppsScreen } from './screens/connected-apps';
import { ContactsScreen } from './screens/contacts';
import { DisbursementsScreen } from './screens/disbursements';
import { DunningScreen } from './screens/dunning';
import { EstimatesScreen } from './screens/estimates';
import { ExpensesScreen } from './screens/expenses';
import { JournalEntryScreen } from './screens/journal-entry';
import { MoneyInScreen } from './screens/money-in';
import { PayBillsScreen } from './screens/pay-bills';
import { OAuthClientsScreen } from './screens/oauth-clients';
import { OAuthConsentScreen } from './screens/oauth-consent';
import { ProcessingScreen } from './screens/processing';
import { PublicInvoiceScreen } from './screens/public-invoice';
import { PurchaseOrdersScreen } from './screens/purchase-orders';
import { PurchasesScreen } from './screens/purchases';
import { QuickBooksImportScreen } from './screens/quickbooks-import';
import { FixedAssetsScreen } from './screens/fixed-assets';
import { RecurringInvoicesScreen } from './screens/recurring-invoices';
import { RecurringJournalsScreen } from './screens/recurring-journals';
import { ReportsScreen } from './screens/reports';
import { SalesScreen } from './screens/sales';
import { SettingsScreen } from './screens/settings';
import { StatementPackagesScreen } from './screens/statement-packages';
import { WorkQueueScreen } from './screens/work-items';
import { AppShell } from './shell/app-shell';
import { landingPath, visibleNavSections } from './shell/nav';
import { OrgControls } from './shell/org-switcher';
import { QueryScopeBoundary } from './shell/query-scope';

/**
 * `<BrowserRouter>` with no data router.
 *
 * `createBrowserRouter` would bring route `loader`s, and a loader is a second place data
 * fetching can live. Spec §5's org switch requires that the query cache be cleared
 * wholesale on switch (see `src/query/client.ts`); data fetched by a loader is not in that
 * cache, so it would survive the clear — the exact cross-tenant leak the clear prevents.
 * One fetching mechanism, and it is TanStack Query. Revisit only if a router feature is
 * needed that the data router alone provides, and then decide what clears the loader data.
 *
 * `QueryScopeBoundary` sits inside the router so that a scope reset remounts the screens
 * without disturbing history — see that module for why the clear needs a remount at all.
 *
 * `/i/:token` (OB-131, Phase 1, S4 — `src/screens/public-invoice.tsx`) is carved out
 * *before* `QueryScopeBoundary` and `AppRoutes`. It is reached by a capability token in
 * the URL by whoever holds the link — ordinarily a customer with no OpenBooks account —
 * so it must call `GET /v1/auth/me` never, join the query cache an org switch clears
 * never, and render inside `<AppShell>` never: all three assume a session this page must
 * not need, even an absent one.
 *
 * `RootRoutes` chooses with `matchPath` rather than nesting `AppRoutes` under a wrapping
 * `<Route path="/*">`. Every route table below — `SignedOutRoutes`, `OrgSelectionRoutes`,
 * `SignedInRoutes` — is written with **absolute** paths (`/accounts`, not `accounts`)
 * because historically each was the outermost `<Routes>`, matched against the full
 * location with no ancestor `<Route>` narrowing it. `src/screens/banking/index.tsx` shows
 * what the *other* convention looks like — **relative** paths under its own
 * `/banking/*` parent — and mixing the two by wrapping `AppRoutes` in a splat `<Route>`
 * here would silently break every absolute path one level down. `RootRoutes` sidesteps the
 * question entirely: it renders `<PublicInvoiceScreen>` through its own unwrapped
 * `<Routes>`, exactly as `AppRoutes` renders its own, so neither tree's path convention
 * changes.
 */
export function App(): ReactElement {
  return (
    <BrowserRouter>
      <RootRoutes />
    </BrowserRouter>
  );
}

function RootRoutes(): ReactElement {
  const location = useLocation();

  if (matchPath('/i/:token', location.pathname) !== null) {
    return (
      <Routes>
        <Route path="/i/:token" element={<PublicInvoiceScreen />} />
      </Routes>
    );
  }

  return (
    <QueryScopeBoundary>
      <AppRoutes />
    </QueryScopeBoundary>
  );
}

/**
 * The guard, and it is the shape of the code rather than a check inside a route.
 *
 * `GET /v1/auth/me` answers one of three things and each gets a route table of its own, so
 * "an unauthenticated visitor reaches the auth screen" is not a redirect that could be
 * forgotten on some future route — it is the only table that exists for them. There is no
 * path to `/accounts` while signed out, because while signed out `/accounts` is not a route.
 *
 * `fetchIdentity` returns `null` for a 401 rather than throwing, which is what keeps "signed
 * out" and "could not ask" on different branches here; the reasoning is in
 * `src/auth/identity.ts`.
 *
 * Exported separately from `App` so tests can mount it under a `MemoryRouter` at a chosen
 * path.
 */
export function AppRoutes(): ReactElement {
  const identity = useIdentity();

  if (identity.isPending) {
    return (
      <AppShell>
        <p className="text-text-subtle">Loading…</p>
      </AppShell>
    );
  }

  /**
   * Reached only by a fault that is not a 401 — a transport failure, a 5xx, a proxy that
   * answered instead of the API. Signing the user out on one of those would be a logout
   * caused by a flaky network, so this offers a retry and nothing else.
   */
  if (identity.isError) {
    return (
      <AppShell>
        <ErrorBanner
          error={identity.error}
          onRetry={() => {
            void identity.refetch();
          }}
        />
      </AppShell>
    );
  }

  if (identity.data === null) return <SignedOutRoutes />;
  if (identity.data.activeOrgId === null) return <OrgSelectionRoutes identity={identity.data} />;
  return <SignedInRoutes identity={identity.data} />;
}

function SignedOutRoutes(): ReactElement {
  return (
    <AppShell>
      <Routes>
        <Route path="/auth" element={<AuthScreen />} />
        <Route path="*" element={<Navigate to="/auth" replace />} />
      </Routes>
    </AppShell>
  );
}

/**
 * A live session with no active organization. Not a login problem and not an error: the user
 * may have been removed from their last org, or may never have had one, and either way
 * signing in again would succeed and change nothing (the note on `OrgSelectionScreen`).
 *
 * Sign-out is offered here because it is the only other way out of this state.
 */
function OrgSelectionRoutes({ identity }: { readonly identity: CallerIdentity }): ReactElement {
  return (
    <AppShell orgIndicator={<SignOutButton />}>
      <Routes>
        <Route path="/select-org" element={<OrgSelectionScreen identity={identity} />} />
        <Route path="*" element={<Navigate to="/select-org" replace />} />
      </Routes>
    </AppShell>
  );
}

/**
 * The application.
 *
 * Every screen is mounted unconditionally. The permission set decides what the *navigation*
 * offers (D-25, and the note in `src/shell/nav.ts`) and it decides nothing here — typing
 * `/reports` with no `reports.read` renders the reports screen, whose own calls are then
 * refused by the service. That is deliberate: a route table filtered by permission is the
 * artifact a reviewer mistakes for enforcement, and once one exists a service check gets
 * omitted "because the route is hidden".
 */
function SignedInRoutes({ identity }: { readonly identity: CallerIdentity }): ReactElement {
  const nav = visibleNavSections(permissionSet(identity));

  return (
    <AppShell nav={nav} orgIndicator={<OrgControls identity={identity} />}>
      <Routes>
        <Route path="/" element={<Navigate to={landingPath(nav)} replace />} />
        <Route path="/accounts" element={<AccountsScreen />} />
        <Route path="/journal-entry" element={<JournalEntryScreen />} />
        <Route path="/contacts" element={<ContactsScreen />} />
        <Route path="/sales/*" element={<SalesScreen />} />
        <Route path="/estimates/*" element={<EstimatesScreen />} />
        <Route path="/recurring-invoices" element={<RecurringInvoicesScreen />} />
        <Route path="/dunning" element={<DunningScreen />} />
        <Route path="/recurring-journals" element={<RecurringJournalsScreen />} />
        <Route path="/fixed-assets" element={<FixedAssetsScreen />} />
        <Route path="/purchase-orders" element={<PurchaseOrdersScreen />} />
        <Route path="/purchases/*" element={<PurchasesScreen />} />
        <Route path="/expenses" element={<ExpensesScreen />} />
        <Route path="/bill-captures" element={<BillCapturesScreen />} />
        <Route path="/pay-bills" element={<PayBillsScreen />} />
        <Route path="/disbursements" element={<DisbursementsScreen />} />
        <Route path="/money" element={<MoneyInScreen />} />
        <Route path="/banking/*" element={<BankingScreen />} />
        <Route path="/processing" element={<ProcessingScreen />} />
        <Route path="/reports" element={<ReportsScreen />} />
        <Route path="/statement-packages" element={<StatementPackagesScreen />} />
        <Route path="/budgets" element={<BudgetsScreen />} />
        <Route path="/settings" element={<SettingsScreen />} />
        <Route path="/quickbooks-import" element={<QuickBooksImportScreen />} />
        <Route path="/api-keys" element={<ApiKeysScreen />} />
        <Route path="/oauth-clients" element={<OAuthClientsScreen />} />
        <Route path="/connected-apps" element={<ConnectedAppsScreen />} />
        <Route path="/agent-proposals" element={<AgentProposalsScreen />} />
        <Route path="/automations" element={<AutomationsScreen />} />
        <Route path="/work-items" element={<WorkQueueScreen />} />
        {/* No nav entry (OB-105): reached only by the 302 `GET /oauth/authorize`
            (`oauth-flow.ts`) sends a logged-in user to, never typed or linked. */}
        <Route path="/oauth/consent" element={<OAuthConsentScreen />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
}
