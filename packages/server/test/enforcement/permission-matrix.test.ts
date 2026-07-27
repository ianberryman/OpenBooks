import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { runInContext, type RequestContext } from '../../src/context';
import { uuidToBuffer } from '../../src/db';
import { toWireError } from '../../src/errors';
import {
  applyChartTemplate,
  createAccount,
  deactivateAccount,
  deleteAccount,
  getAccount,
  listAccounts,
  listChartTemplates,
  reactivateAccount,
  updateAccount,
} from '../../src/modules/accounts';
import {
  createContact,
  deactivateContact,
  deleteContact,
  getContact,
  listContacts,
  reactivateContact,
  updateContact,
} from '../../src/modules/contacts';
import {
  archiveDimension,
  archiveDimensionValue,
  createDimension,
  createDimensionValue,
  deleteDimension,
  deleteDimensionValue,
  getDimension,
  getDimensionValue,
  getJournalLineDimensions,
  listDimensions,
  listDimensionValues,
  setJournalLineDimensions,
  unarchiveDimension,
  unarchiveDimensionValue,
  updateDimension,
  updateDimensionValue,
} from '../../src/modules/dimensions';
import {
  createDraft,
  discardDraft,
  getDraft,
  listDrafts,
  postDraft,
  updateDraft,
} from '../../src/modules/drafts';
import {
  getTrialBalance,
  listJournals,
  postJournal,
  reverseJournal,
} from '../../src/modules/ledger';
import {
  changeMemberRole,
  inviteMember,
  listAssignableRoles,
  listInvites,
  listMembers,
  removeMember,
  revokeInvite,
} from '../../src/modules/members';
import type { PermissionKey } from '../../src/modules/permissions';
import { PERMISSION_KEYS, selectCatalogCodes } from '../../src/modules/permissions';
import {
  closePeriod,
  createPeriod,
  generateFiscalYear,
  getPeriod,
  listPeriods,
  reopenPeriod,
} from '../../src/modules/periods';
import {
  getAccountBalances,
  getBalanceSheet,
  getGeneralLedger,
  getProfitAndLoss,
} from '../../src/modules/reports';
import { generateOpenApiDocument } from '../../src/transport';
import { buildTestApp } from '../transport/harness';
import { newUuid, SYSTEM_ROLE_UUIDS, systemRoleId, type SystemRoleName } from '../db';
import { captureEmail } from '../members/support';
import { useServiceDatabase } from '../permissions/support';
import { contextFor } from './support';

/**
 * **B10 — every M2 operation, against every seeded role, at the service.**
 *
 * ## Why this is a service-layer matrix and not a route-layer one
 *
 * D-25 decides that the permission set `GET /v1/me` returns is *advisory*: screens
 * hide what the caller cannot do, and the service refuses regardless. A matrix
 * driven through `app.inject` would exercise the routes, and the routes hold no
 * authorization at all — `requirePermission` is service-layer only and
 * dependency-cruiser enforces it. So a route-level matrix would be asserting that
 * the advisory layer happens to agree with the gate, which is the one thing D-25
 * says not to trust. Every row below calls the service function directly, inside
 * the context scope the request path opens.
 *
 * ## How a row is judged
 *
 * The only question asked is *did the gate refuse* — an operation that gets past
 * `requirePermission` and then fails on a precondition, a missing row, or a closed
 * period is `allowed`, because the gate let it through. That is deliberate: the
 * matrix is about authority, not about applicability, and tying the two together
 * would make a verdict depend on the order rows happen to run in.
 *
 * That leaves one way for a row to be vacuous — a service with no gate at all
 * would read `allowed` for every role and look like a wide-open read. `nobody`
 * closes it: an extra pass with a role id naming no row, which
 * `permissions.service.ts` documents as resolving to the empty set. Every
 * operation must be refused for it, *and* the key it is refused with must be the
 * key the row declares. So each row's declared permission is verified against the
 * one the service actually checks, rather than being a comment.
 *
 * ## What this file is for beyond today
 *
 * Known gap 6: the catalog seeds all 48 codes including AR/AP, so a Bookkeeper
 * already holds `invoices.write` — it is simply that nothing checks it yet. When
 * M3 adds its first invoice operation, `GRANTED_TO` gains a row reading
 * `invoices.write: owner, bookkeeper, arOnly` and `LATENT_GRANTS` loses that code
 * from four roles, in the same commit, with no migration between them. The
 * widening becomes two edits a reviewer has to approve rather than a fact nobody
 * ever writes down. `LATENT_GRANTS` is that fact, written down.
 */
const db = useServiceDatabase();

// `inviteMember` sends. The real `log` adapter over a capture stream, because a
// stubbed provider would make the one row that exercises `members.write` a test of
// the stub (spec §11).
captureEmail();

const ROLES = [
  'owner',
  'bookkeeper',
  'apOnly',
  'arOnly',
  'readOnly',
  'approver',
] as const satisfies readonly SystemRoleName[];

/**
 * Which of the six seeded roles hold each permission that has an enforcement point
 * today.
 *
 * Written out rather than read from `role_permissions`, which is the entire point:
 * derived expectations move when the seeds move and a matrix that agrees with the
 * database by construction can never disagree with it. This table is the claim; the
 * database is what it is checked against.
 *
 * Seventeen rows, because seventeen of the catalog's forty-eight codes are checked
 * by a service. The other thirty-one are `LATENT_GRANTS` below.
 */
const GRANTED_TO: Readonly<Record<string, readonly SystemRoleName[]>> = {
  'accounts.read': ['owner', 'bookkeeper', 'apOnly', 'arOnly', 'readOnly', 'approver'],
  'accounts.write': ['owner', 'bookkeeper'],
  'contacts.read': ['owner', 'bookkeeper', 'apOnly', 'arOnly', 'readOnly', 'approver'],
  // AP-only and AR-only hold `contacts.write` — a vendor or a customer is created
  // in the course of entering the bill or the invoice it belongs to.
  'contacts.write': ['owner', 'bookkeeper', 'apOnly', 'arOnly'],
  'dimensions.read': ['owner', 'bookkeeper', 'apOnly', 'arOnly', 'readOnly', 'approver'],
  'dimensions.write': ['owner', 'bookkeeper'],
  'journals.read': ['owner', 'bookkeeper', 'apOnly', 'arOnly', 'readOnly', 'approver'],
  // Approver holds it, and D-30 turns on exactly that: drafting reuses this code,
  // so a role whose bundle is `%.read` plus `journals.post` can compose a proposal
  // as well as post one. See `Approver composes and posts a draft` below.
  'journals.post': ['owner', 'bookkeeper', 'approver'],
  'journals.reverse': ['owner', 'bookkeeper'],
  'members.read': ['owner', 'bookkeeper', 'readOnly', 'approver'],
  // The one code Bookkeeper is excluded from among the seventeen: a bookkeeper runs
  // the books, they do not decide who has access.
  'members.write': ['owner'],
  'periods.read': ['owner', 'bookkeeper', 'apOnly', 'arOnly', 'readOnly', 'approver'],
  'periods.write': ['owner', 'bookkeeper'],
  // Not Read-only / Accountant, even though closing writes no journal: `0001_tenancy`
  // states that closing a period is a change.
  'periods.close': ['owner', 'bookkeeper'],
  'periods.reopen': ['owner', 'bookkeeper'],
  'reports.read': ['owner', 'bookkeeper', 'apOnly', 'arOnly', 'readOnly', 'approver'],
  'roles.read': ['owner', 'bookkeeper', 'readOnly', 'approver'],
};

/**
 * Everything each role holds that **nothing checks** — known gap 6, enumerated.
 *
 * A code in this table is a capability the role has been granted and cannot
 * currently exercise, because no service calls `requirePermission` with it. The
 * moment M3 writes that call, the code moves from here into `GRANTED_TO` and the
 * role silently gains a power it always held. Bookkeeper's twenty-six entries are
 * the headline: `invoices.write`, `bills.void`, `payments_made.write` and the rest
 * are already granted, so M3 widens the role by writing a service, not a migration.
 *
 * `agents.review` on Approver is the same shape from M5, and `banking.*` on
 * Bookkeeper from M4.
 */
const LATENT_GRANTS: Readonly<Record<SystemRoleName, readonly string[]>> = {
  owner: [
    'agents.review',
    'api_keys.read',
    'api_keys.write',
    'banking.import',
    'banking.match',
    'banking.read',
    'banking.reconcile',
    'banking.reopen',
    'bills.read',
    'bills.void',
    'bills.write',
    'credit_notes.read',
    'credit_notes.write',
    'integrations.read',
    'integrations.write',
    'invoices.read',
    'invoices.void',
    'invoices.write',
    'orgs.read',
    'orgs.write',
    'payments_made.read',
    'payments_made.write',
    'payments_received.read',
    'payments_received.write',
    'tax_rates.read',
    'tax_rates.write',
    'vendor_credits.read',
    'vendor_credits.write',
    'workflows.activate',
    'workflows.read',
    'workflows.write',
  ],
  bookkeeper: [
    'agents.review',
    'banking.import',
    'banking.match',
    'banking.read',
    'banking.reconcile',
    'banking.reopen',
    'bills.read',
    'bills.void',
    'bills.write',
    'credit_notes.read',
    'credit_notes.write',
    'integrations.read',
    'invoices.read',
    'invoices.void',
    'invoices.write',
    'orgs.read',
    'payments_made.read',
    'payments_made.write',
    'payments_received.read',
    'payments_received.write',
    'tax_rates.read',
    'tax_rates.write',
    'vendor_credits.read',
    'vendor_credits.write',
    'workflows.read',
    'workflows.write',
  ],
  apOnly: [
    'bills.read',
    'bills.void',
    'bills.write',
    'payments_made.read',
    'payments_made.write',
    'tax_rates.read',
    'vendor_credits.read',
    'vendor_credits.write',
  ],
  arOnly: [
    'credit_notes.read',
    'credit_notes.write',
    'invoices.read',
    'invoices.void',
    'invoices.write',
    'payments_received.read',
    'payments_received.write',
    'tax_rates.read',
  ],
  readOnly: [
    'banking.read',
    'bills.read',
    'credit_notes.read',
    'integrations.read',
    'invoices.read',
    'orgs.read',
    'payments_made.read',
    'payments_received.read',
    'tax_rates.read',
    'vendor_credits.read',
    'workflows.read',
  ],
  approver: [
    'agents.review',
    'banking.read',
    'bills.read',
    'credit_notes.read',
    'integrations.read',
    'invoices.read',
    'orgs.read',
    'payments_made.read',
    'payments_received.read',
    'tax_rates.read',
    'vendor_credits.read',
    'workflows.read',
  ],
};

/** Everything a matrix row needs in the org it is being run against. */
interface Scene {
  readonly ctx: RequestContext;
  readonly orgUuid: string;
  readonly cashId: string;
  readonly revenueId: string;
  readonly periodId: string;
  readonly date: string;
  readonly journalId: string;
  readonly journalLineId: string;
  readonly contactId: string;
  readonly dimensionId: string;
  readonly dimensionValueId: string;
  readonly draftId: string;
  readonly discardableDraftId: string;
  readonly inviteId: string;
  readonly otherUserId: string;
  readonly actorId: string;
}

/**
 * One operation, its declared permission, and how to reach it.
 *
 * `operationId` is the route the operation is published as, present so the coverage
 * check below can compare this table against the generated OpenAPI document — the
 * same mechanism `cross-org.test.ts` uses, and for the same reason: a hand-kept
 * list of operations is only as complete as whoever last added a route remembered
 * to make it. The two rows without one are services with no route yet.
 */
interface Operation {
  readonly name: string;
  readonly operationId: string | null;
  readonly permission: PermissionKey;
  readonly call: (scene: Scene) => Promise<unknown>;
}

const OPERATIONS: readonly Operation[] = [
  {
    name: 'createAccount',
    operationId: 'createAccount',
    permission: 'accounts.write',
    call: (s) =>
      createAccount(
        { code: '9100', name: 'Sundry', type: 'expense', normalBalance: 'debit' },
        s.ctx,
      ),
  },
  {
    name: 'getAccount',
    operationId: 'getAccount',
    permission: 'accounts.read',
    call: (s) => getAccount(s.cashId, s.ctx),
  },
  {
    name: 'listAccounts',
    operationId: 'listAccounts',
    permission: 'accounts.read',
    call: (s) => listAccounts({}, s.ctx),
  },
  {
    name: 'updateAccount',
    operationId: 'updateAccount',
    permission: 'accounts.write',
    call: (s) => updateAccount(s.cashId, { name: 'Cash at bank' }, s.ctx),
  },
  {
    name: 'deactivateAccount',
    operationId: 'deactivateAccount',
    permission: 'accounts.write',
    call: (s) => deactivateAccount(s.cashId, s.ctx),
  },
  {
    name: 'reactivateAccount',
    operationId: 'reactivateAccount',
    permission: 'accounts.write',
    call: (s) => reactivateAccount(s.cashId, s.ctx),
  },
  {
    name: 'deleteAccount',
    operationId: 'deleteAccount',
    permission: 'accounts.write',
    call: (s) => deleteAccount(s.cashId, s.ctx),
  },
  {
    name: 'listChartTemplates',
    operationId: 'listChartTemplates',
    permission: 'accounts.read',
    call: (s) => listChartTemplates(s.ctx),
  },
  {
    name: 'applyChartTemplate',
    operationId: 'applyChartTemplate',
    permission: 'accounts.write',
    call: (s) => applyChartTemplate({ templateId: 'general_small_business' }, s.ctx),
  },
  {
    name: 'createContact',
    operationId: 'createContact',
    permission: 'contacts.write',
    call: (s) => createContact({ displayName: 'Globex' }, s.ctx),
  },
  {
    name: 'getContact',
    operationId: 'getContact',
    permission: 'contacts.read',
    call: (s) => getContact(s.contactId, s.ctx),
  },
  {
    name: 'listContacts',
    operationId: 'listContacts',
    permission: 'contacts.read',
    call: (s) => listContacts({}, s.ctx),
  },
  {
    name: 'updateContact',
    operationId: 'updateContact',
    permission: 'contacts.write',
    call: (s) => updateContact(s.contactId, { displayName: 'Acme Inc' }, s.ctx),
  },
  {
    name: 'deactivateContact',
    operationId: 'deactivateContact',
    permission: 'contacts.write',
    call: (s) => deactivateContact(s.contactId, s.ctx),
  },
  {
    name: 'reactivateContact',
    operationId: 'reactivateContact',
    permission: 'contacts.write',
    call: (s) => reactivateContact(s.contactId, s.ctx),
  },
  {
    name: 'deleteContact',
    operationId: 'deleteContact',
    permission: 'contacts.write',
    call: (s) => deleteContact(s.contactId, s.ctx),
  },
  {
    name: 'createDimension',
    operationId: 'createDimension',
    permission: 'dimensions.write',
    call: (s) => createDimension({ code: 'REGION', name: 'Region' }, s.ctx),
  },
  {
    name: 'getDimension',
    operationId: 'getDimension',
    permission: 'dimensions.read',
    call: (s) => getDimension(s.dimensionId, s.ctx),
  },
  {
    name: 'listDimensions',
    operationId: 'listDimensions',
    permission: 'dimensions.read',
    call: (s) => listDimensions({}, s.ctx),
  },
  {
    name: 'updateDimension',
    operationId: 'updateDimension',
    permission: 'dimensions.write',
    call: (s) => updateDimension(s.dimensionId, { name: 'Cost centre' }, s.ctx),
  },
  {
    name: 'archiveDimension',
    operationId: 'archiveDimension',
    permission: 'dimensions.write',
    call: (s) => archiveDimension(s.dimensionId, s.ctx),
  },
  {
    name: 'unarchiveDimension',
    operationId: 'unarchiveDimension',
    permission: 'dimensions.write',
    call: (s) => unarchiveDimension(s.dimensionId, s.ctx),
  },
  {
    name: 'createDimensionValue',
    operationId: 'createDimensionValue',
    permission: 'dimensions.write',
    call: (s) => createDimensionValue(s.dimensionId, { code: 'OPS', name: 'Operations' }, s.ctx),
  },
  {
    name: 'getDimensionValue',
    operationId: 'getDimensionValue',
    permission: 'dimensions.read',
    call: (s) => getDimensionValue(s.dimensionValueId, s.ctx),
  },
  {
    name: 'listDimensionValues',
    operationId: 'listDimensionValues',
    permission: 'dimensions.read',
    call: (s) => listDimensionValues(s.dimensionId, {}, s.ctx),
  },
  {
    name: 'updateDimensionValue',
    operationId: 'updateDimensionValue',
    permission: 'dimensions.write',
    call: (s) => updateDimensionValue(s.dimensionValueId, { name: 'Sales team' }, s.ctx),
  },
  {
    name: 'archiveDimensionValue',
    operationId: 'archiveDimensionValue',
    permission: 'dimensions.write',
    call: (s) => archiveDimensionValue(s.dimensionValueId, s.ctx),
  },
  {
    name: 'unarchiveDimensionValue',
    operationId: 'unarchiveDimensionValue',
    permission: 'dimensions.write',
    call: (s) => unarchiveDimensionValue(s.dimensionValueId, s.ctx),
  },
  {
    name: 'deleteDimensionValue',
    operationId: 'deleteDimensionValue',
    permission: 'dimensions.write',
    call: (s) => deleteDimensionValue(s.dimensionValueId, s.ctx),
  },
  {
    name: 'deleteDimension',
    operationId: 'deleteDimension',
    permission: 'dimensions.write',
    call: (s) => deleteDimension(s.dimensionId, s.ctx),
  },
  {
    name: 'getJournalLineDimensions',
    operationId: 'getJournalLineDimensions',
    permission: 'dimensions.read',
    call: (s) => getJournalLineDimensions(s.journalLineId, s.ctx),
  },
  {
    name: 'setJournalLineDimensions',
    operationId: 'setJournalLineDimensions',
    permission: 'dimensions.write',
    call: (s) => setJournalLineDimensions(s.journalLineId, { valueIds: [] }, s.ctx),
  },
  {
    name: 'createDraft',
    operationId: 'createDraft',
    permission: 'journals.post',
    call: (s) => createDraft({ entryDate: s.date, memo: 'Proposal' }, s.ctx),
  },
  {
    name: 'getDraft',
    operationId: 'getDraft',
    permission: 'journals.read',
    call: (s) => getDraft(s.draftId, s.ctx),
  },
  {
    name: 'listDrafts',
    operationId: 'listDrafts',
    permission: 'journals.read',
    call: (s) => listDrafts({}, s.ctx),
  },
  {
    name: 'updateDraft',
    operationId: 'updateDraft',
    permission: 'journals.post',
    call: (s) => updateDraft(s.draftId, { memo: 'Edited' }, s.ctx),
  },
  {
    name: 'postDraft',
    operationId: 'postDraft',
    permission: 'journals.post',
    call: (s) => postDraft(s.draftId, s.ctx),
  },
  // A second draft, because `postDraft` above consumes the first (D-19).
  {
    name: 'discardDraft',
    operationId: 'discardDraft',
    permission: 'journals.post',
    call: (s) => discardDraft(s.discardableDraftId, s.ctx),
  },
  {
    name: 'postJournal',
    operationId: 'postJournal',
    permission: 'journals.post',
    call: (s) =>
      postJournal(
        {
          date: s.date,
          actorType: 'user',
          actorId: s.actorId,
          lines: [
            { accountId: s.cashId, side: 'debit', amount: 5000n },
            { accountId: s.revenueId, side: 'credit', amount: 5000n },
          ],
        },
        s.ctx,
      ),
  },
  {
    name: 'reverseJournal',
    operationId: 'reverseJournal',
    permission: 'journals.reverse',
    call: (s) =>
      reverseJournal(
        { journalId: s.journalId, date: s.date, actorType: 'user', actorId: s.actorId },
        s.ctx,
      ),
  },
  {
    name: 'listJournals',
    operationId: 'listJournals',
    permission: 'journals.read',
    call: (s) => listJournals({}, s.ctx),
  },
  {
    name: 'listMembers',
    operationId: 'listMembers',
    permission: 'members.read',
    call: (s) => listMembers(s.ctx),
  },
  {
    name: 'listAssignableRoles',
    operationId: 'listAssignableRoles',
    permission: 'roles.read',
    call: (s) => listAssignableRoles(s.ctx),
  },
  {
    name: 'changeMemberRole',
    operationId: 'changeMemberRole',
    permission: 'members.write',
    call: (s) =>
      changeMemberRole({ userId: s.otherUserId, roleId: SYSTEM_ROLE_UUIDS.readOnly }, s.ctx),
  },
  {
    name: 'removeMember',
    operationId: 'removeMember',
    permission: 'members.write',
    call: (s) => removeMember({ userId: s.otherUserId }, s.ctx),
  },
  {
    name: 'inviteMember',
    operationId: 'inviteMember',
    permission: 'members.write',
    call: (s) =>
      inviteMember(
        { email: `invited-${s.orgUuid}@openbooks.test`, roleId: SYSTEM_ROLE_UUIDS.bookkeeper },
        s.ctx,
      ),
  },
  {
    name: 'listInvites',
    operationId: 'listInvites',
    permission: 'members.read',
    call: (s) => listInvites(s.ctx),
  },
  {
    name: 'revokeInvite',
    operationId: 'revokeInvite',
    permission: 'members.write',
    call: (s) => revokeInvite({ inviteId: s.inviteId }, s.ctx),
  },
  {
    name: 'generateFiscalYear',
    operationId: 'generateFiscalYear',
    permission: 'periods.write',
    call: () => generateFiscalYear({ fiscalYear: 2027 }),
  },
  {
    name: 'createPeriod',
    operationId: 'createFiscalPeriod',
    permission: 'periods.write',
    call: () => createPeriod({ year: 2028, month: 6 }),
  },
  {
    name: 'listPeriods',
    operationId: 'listFiscalPeriods',
    permission: 'periods.read',
    call: () => listPeriods({}),
  },
  {
    name: 'closePeriod',
    operationId: 'closeFiscalPeriod',
    permission: 'periods.close',
    call: (s) => closePeriod({ periodId: s.periodId }),
  },
  {
    name: 'reopenPeriod',
    operationId: 'reopenFiscalPeriod',
    permission: 'periods.reopen',
    call: (s) => reopenPeriod({ periodId: s.periodId }),
  },
  /**
   * No route. `getPeriod` is the read a future period-detail screen is built on,
   * so it is in the matrix before it is on the wire — the alternative is that its
   * first authorization check is written by whoever adds the route.
   */
  {
    name: 'getPeriod',
    operationId: null,
    permission: 'periods.read',
    call: (s) => getPeriod({ periodId: s.periodId }),
  },
  {
    name: 'getTrialBalance',
    operationId: 'getTrialBalance',
    permission: 'reports.read',
    call: (s) => getTrialBalance({}, s.ctx),
  },
  {
    name: 'getProfitAndLoss',
    operationId: 'getProfitAndLoss',
    permission: 'reports.read',
    call: (s) => getProfitAndLoss({}, s.ctx),
  },
  {
    name: 'getBalanceSheet',
    operationId: 'getBalanceSheet',
    permission: 'reports.read',
    call: (s) => getBalanceSheet({ asOf: s.date }, s.ctx),
  },
  {
    name: 'getGeneralLedger',
    operationId: 'getGeneralLedger',
    permission: 'reports.read',
    call: (s) => getGeneralLedger({ accountId: s.cashId }, s.ctx),
  },
  /**
   * No route either — the report *core* every projection above is assembled from.
   * It carries its own `requirePermission` rather than trusting its callers, and
   * this row is what says so.
   */
  {
    name: 'getAccountBalances',
    operationId: null,
    permission: 'reports.read',
    call: (s) => getAccountBalances({}, s.ctx),
  },
];

/**
 * The route operations that reach no `requirePermission` at all, and why.
 *
 * Every one of them either establishes an identity or acts on a credential the
 * caller already holds, so there is no role to check against yet: `resolveMembership`
 * and the invite token are the gate instead. Listed rather than filtered by a
 * pattern, so adding a route to this set is a deliberate edit that shows in a diff.
 */
const UNGATED_OPERATIONS: ReadonlySet<string> = new Set([
  // Liveness. It reaches no org and no role, which is the point of it.
  'getHealth',
  'register',
  'login',
  'logout',
  'getCurrentIdentity',
  // Membership, not permission: the token proves the invitation, and the caller is
  // not a member of the org yet, so no role exists to hold `members.write`.
  'acceptInvite',
  // Creating an org makes the caller its Owner; requiring a permission in an org
  // that does not exist is not expressible.
  'createOrg',
  // Both answer questions about the caller's own memberships, which is why
  // `resolveOrgMembership` — not a permission — is what converts "not a member" into
  // the A7 404.
  'listOrgMemberships',
  'switchActiveOrg',
]);

async function scene(role: SystemRoleName): Promise<Scene> {
  const org = await db.factories.org();
  const user = await db.factories.user();
  const other = await db.factories.user();
  await db.factories.orgMember({ orgId: org.id, userId: user.id, roleId: systemRoleId(role) });
  await db.factories.orgMember({ orgId: org.id, userId: other.id, roleId: systemRoleId('owner') });

  const period = await db.factories.fiscalPeriod({ orgId: org.id });
  const cash = await db.factories.account({
    orgId: org.id,
    code: '1000',
    type: 'asset',
    normalBalance: 'debit',
  });
  const revenue = await db.factories.account({
    orgId: org.id,
    code: '4000',
    type: 'revenue',
    normalBalance: 'credit',
  });
  const journal = await db.factories.journal({
    orgId: org.id,
    periodId: period.id,
    entryDate: period.startDate,
    actorId: user.id,
    lines: [
      { accountId: cash.id, debitMinor: 150000n },
      { accountId: revenue.id, creditMinor: 150000n },
    ],
  });

  // `journal_lines.id` is a `BIGINT` the database allocates, so it is read back
  // rather than generated — the tagging surface addresses a line by it.
  const line = await db.app
    .selectFrom('journal_lines')
    .select('id')
    .where('org_id', '=', org.id)
    .where('journal_id', '=', journal.id)
    .orderBy('line_number')
    .executeTakeFirstOrThrow();

  /**
   * The rest is built through the services, as an Owner in the same org.
   *
   * Not through the factories: contacts, dimensions, and drafts have no factory,
   * and writing raw inserts for them here would mean this file carried its own idea
   * of what those rows look like. The setup context is always Owner regardless of
   * the role under test, so a role that cannot create a contact still has one to be
   * refused against — otherwise `getContact` for Read-only would be judged on a
   * missing row.
   */
  const setup = contextFor(org.uuid, SYSTEM_ROLE_UUIDS.owner, user.uuid);
  const contact = await createContact({ displayName: 'Acme Ltd' }, setup);
  const dimension = await createDimension({ code: 'DEPT', name: 'Department' }, setup);
  const value = await createDimensionValue(dimension.id, { code: 'SALES', name: 'Sales' }, setup);
  const draft = await createDraft({ entryDate: period.startDate, memo: 'Draft' }, setup);
  const discardable = await createDraft({ entryDate: period.startDate }, setup);
  const invite = await inviteMember(
    { email: `pending-${org.uuid}@openbooks.test`, roleId: SYSTEM_ROLE_UUIDS.readOnly },
    setup,
  );

  return {
    ctx: contextFor(org.uuid, SYSTEM_ROLE_UUIDS[role], user.uuid),
    orgUuid: org.uuid,
    cashId: cash.uuid,
    revenueId: revenue.uuid,
    periodId: period.uuid,
    date: period.startDate,
    journalId: journal.uuid,
    journalLineId: String(line.id),
    contactId: contact.id,
    dimensionId: dimension.id,
    dimensionValueId: value.id,
    draftId: draft.id,
    discardableDraftId: discardable.id,
    inviteId: invite.invitation.id,
    otherUserId: other.uuid,
    actorId: user.uuid,
  };
}

/** `allowed`, or the exact permission the gate named when it refused. */
type Verdict = 'allowed' | `refused ${string}`;

async function judge(operation: Operation, built: Scene): Promise<Verdict> {
  try {
    await runInContext(built.ctx, () => operation.call(built));
    return 'allowed';
  } catch (error: unknown) {
    const wire = toWireError(error);
    if (wire.code !== 'permission_denied') return 'allowed';
    // Through `toWireError` rather than off the class, because what a caller can
    // distinguish is what reaches the wire — and the key is the whole payload a
    // `403` is permitted to carry (see `PermissionDeniedError`).
    const details = wire.details as { readonly permission?: string } | undefined;
    return `refused ${String(details?.permission)}`;
  }
}

/** A pass over every operation with one role's context. */
async function pass(role: SystemRoleName): Promise<Record<string, Verdict>> {
  const built = await scene(role);
  const verdicts: Record<string, Verdict> = {};
  for (const operation of OPERATIONS) {
    verdicts[operation.name] = await judge(operation, built);
  }
  return verdicts;
}

function expectedFor(role: SystemRoleName): Record<string, Verdict> {
  return Object.fromEntries(
    OPERATIONS.map((operation) => [
      operation.name,
      GRANTED_TO[operation.permission]?.includes(role) === true
        ? 'allowed'
        : `refused ${operation.permission}`,
    ]),
  );
}

describe('B10 — the permission matrix, at the service layer', () => {
  /**
   * The negative control, and the reason the six passes below are not vacuous.
   *
   * A role id naming no row resolves to the empty permission set — stated in
   * `requirePermission`'s own commentary as one of the degenerate cases that fail
   * closed. So every operation must refuse it, and must refuse it *with the key the
   * row declares*: that is what turns each `permission` field from a comment into an
   * assertion, and it is what would catch a service whose gate checks the wrong
   * code or has been deleted entirely.
   */
  it('refuses every operation to a role that holds nothing, naming the declared key', async () => {
    const built = await scene('owner');
    const nobody = { ...built, ctx: contextFor(built.orgUuid, newUuid(), built.otherUserId) };

    const verdicts: Record<string, Verdict> = {};
    for (const operation of OPERATIONS) {
      verdicts[operation.name] = await judge(operation, nobody);
    }

    expect(verdicts).toEqual(
      Object.fromEntries(
        OPERATIONS.map((operation) => [operation.name, `refused ${operation.permission}`]),
      ),
    );
  });

  // One test per role rather than one over all six: a failure should name the role,
  // and each pass builds its own org so a destructive operation in one cannot change
  // what another sees.
  it.each(ROLES)('%s is allowed exactly what the seeds grant it', async (role) => {
    expect(await pass(role)).toEqual(expectedFor(role));
  });

  /**
   * The converse of the matrix, by the same mechanism `cross-org.test.ts` uses:
   * compared against the *generated* OpenAPI document rather than a hand-kept list,
   * so an operation added to the API without a row here is named as uncovered before
   * it can ship unasserted.
   */
  it('covers every published operation that has a permission gate', async () => {
    const built = await buildTestApp();
    try {
      const document = JSON.parse(await generateOpenApiDocument(built.app)) as {
        paths: Record<string, Record<string, { operationId: string }>>;
      };

      const published = Object.values(document.paths)
        .flatMap((item) => Object.values(item).map((operation) => operation.operationId))
        .filter((operationId) => !UNGATED_OPERATIONS.has(operationId))
        .sort();

      const covered = OPERATIONS.map((operation) => operation.operationId)
        .filter((operationId): operationId is string => operationId !== null)
        .sort();

      expect(covered).toEqual(published);
    } finally {
      await built.app.close();
    }
  });

  /**
   * The same converse on the permission axis.
   *
   * Read out of the source rather than out of the matrix, because the matrix is
   * what is being checked: the set of codes any service actually enforces has to
   * equal the set the rows declare. A new enforcement point on a code no row names
   * — the shape M3's first invoice service will have — fails here, and the fix is
   * to add the row and move the code out of `LATENT_GRANTS`.
   *
   * `src/modules/permissions/` is excluded because it is where the mechanism is
   * defined: its commentary spells `requirePermission(ctx, 'invoices.write')` as
   * the example spec §5 gives, and a scan that counted the documentation would
   * report an enforcement point that does not exist.
   */
  it('names every permission any service enforces', () => {
    const enforced = new Set<string>();
    for (const file of serviceSources()) {
      for (const match of file.matchAll(/requirePermission\(\s*ctx,\s*'([a-z_.]+)'\s*\)/g)) {
        const [, key] = match;
        if (key !== undefined) enforced.add(key);
      }
    }

    expect([...enforced].sort()).toEqual(Object.keys(GRANTED_TO).sort());
    expect([...new Set(OPERATIONS.map((operation) => operation.permission))].sort()).toEqual(
      Object.keys(GRANTED_TO).sort(),
    );
  });
});

/**
 * **D-30 — drafting reuses `journals.post`, and Approver is the reason.**
 *
 * The matrix above already records `createDraft` and `postDraft` as `journals.post`,
 * but a matrix cannot say why that matters: swap the code for a hypothetical
 * `journals.draft` and every row above still passes, because a new code would land
 * in Owner and Bookkeeper by construction and those are the two roles a
 * write-shaped row is usually checked against.
 *
 * Approver is where the two answers differ. Its bundle is `%.read` plus a named few
 * including `journals.post`, so under D-30 it can compose a proposal and turn it
 * into a posting — which is the whole point of the role — and under a separate
 * draft code it could post an entry it was not allowed to write. Nothing else in
 * the suite would notice that change, so it is asserted end to end here: compose,
 * post, and read the journal back out of the ledger.
 */
describe('D-30 — Approver composes and posts a draft', () => {
  it('takes an Approver from an empty draft to a journal in the ledger', async () => {
    const built = await scene('approver');

    const composed = await runInContext(built.ctx, () =>
      createDraft(
        {
          entryDate: built.date,
          memo: 'Proposed by the approver',
          lines: [
            { accountId: built.cashId, side: 'debit', amount: '2500' },
            { accountId: built.revenueId, side: 'credit', amount: '2500' },
          ],
        },
        built.ctx,
      ),
    );

    // The edit, because "compose" is not one call: a proposal is worked on, and
    // `updateDraft` is the same permission for the same reason.
    await runInContext(built.ctx, () =>
      updateDraft(composed.id, { memo: 'Reviewed and approved' }, built.ctx),
    );

    const posted = await runInContext(built.ctx, () => postDraft(composed.id, built.ctx));

    const row = await db.app
      .selectFrom('journals')
      .select(['memo', 'source'])
      .where('id', '=', uuidToBuffer(posted.journalId))
      .executeTakeFirstOrThrow();
    expect(row.memo).toBe('Reviewed and approved');

    // And the boundary the role does *not* cross: an Approver reviews proposals, it
    // does not correct the ledger. `journals.reverse` is a separate code and is not
    // in the bundle, so the one write it can make is the one it was granted.
    await expect(
      runInContext(built.ctx, () =>
        reverseJournal(
          {
            journalId: posted.journalId,
            date: built.date,
            actorType: 'user',
            actorId: built.actorId,
          },
          built.ctx,
        ),
      ),
    ).rejects.toMatchObject({ details: { permission: 'journals.reverse' } });
  });
});

/**
 * **Known gap 6, written down.**
 *
 * The roadmap records it as a sentence: "the permission catalog seeds all 48 codes
 * including AR/AP, so when M3 lands a Bookkeeper gains invoice powers with no
 * migration and no audit event… the widening is invisible". This is what makes it
 * visible. `LATENT_GRANTS` is every code a role holds that no service checks, and
 * the only way for a code to leave one of these lists is for someone to write a
 * `requirePermission` for it — at which point the same commit must add the code to
 * `GRANTED_TO` and a row to `OPERATIONS`, or the two tests above fail.
 */
describe('gap 6 — the grants that nothing checks yet', () => {
  it('is exactly the catalog minus the seventeen codes with an enforcement point', async () => {
    const catalog = await selectCatalogCodes();
    // Against the union rather than the type, so a code deleted from the seeds
    // without being deleted from the catalog union is caught here too.
    expect([...catalog].sort()).toEqual([...PERMISSION_KEYS].sort());

    const enforced = new Set(Object.keys(GRANTED_TO));
    const latent = catalog.filter((code) => !enforced.has(code)).sort();

    expect(latent).toEqual([...new Set(Object.values(LATENT_GRANTS).flat())].sort());
    expect(latent).toHaveLength(31);
  });

  it.each(ROLES)('%s holds these codes and can exercise none of them', async (role) => {
    const rows = await db.app
      .selectFrom('role_permissions')
      .select('permission_code')
      .where('role_id', '=', systemRoleId(role))
      .execute();

    const enforced = new Set(Object.keys(GRANTED_TO));
    const held = rows.map((row) => row.permission_code);

    expect(held.filter((code) => !enforced.has(code)).sort()).toEqual([...LATENT_GRANTS[role]]);
  });
});

const MODULES_DIR = fileURLToPath(new URL('../../src/modules/', import.meta.url));

function serviceSources(): readonly string[] {
  return readdirSync(MODULES_DIR, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.service.ts'))
    .filter((name) => !name.startsWith('permissions'))
    .map((name) => readFileSync(join(MODULES_DIR, name), 'utf8'));
}
