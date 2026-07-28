import { describe, expect, it } from 'vitest';

import { runInContext, type RequestContext } from '../../src/context';
import { toWireError } from '../../src/errors';
import {
  approveBill,
  approveVendorCredit,
  createBill,
  createVendorCredit,
  discardBill,
  discardVendorCredit,
  updateBill,
  updateVendorCredit,
  voidBill,
  voidVendorCredit,
} from '../../src/modules/bills';
import { createContact } from '../../src/modules/contacts';
import {
  approveCreditNote,
  approveInvoice,
  createCreditNote,
  createInvoice,
  discardCreditNote,
  discardInvoice,
  updateCreditNote,
  updateInvoice,
  voidCreditNote,
  voidInvoice,
} from '../../src/modules/invoices';
import {
  allocateCreditNote,
  allocatePayment,
  allocateVendorCredit,
  recordPayment,
} from '../../src/modules/payments';
import { SYSTEM_ROLE_UUIDS, systemRoleId } from '../db';
import { useServiceDatabase } from '../permissions/support';
import { contextFor } from './support';

/**
 * **The AR and AP subledgers now spell the four shared refusals identically
 * (OB-092).**
 *
 * They did not. AR reported editing an approved document as `document_not_draft`, a
 * double approval and a double void as a bare `409 conflict` with **no `details`
 * bag at all**, and a void-with-allocations as `document_allocated` — while AP used
 * `document_approved`, `document_already_approved`, `document_already_void` and
 * `document_has_allocations`, all `412 precondition_failed`. A client branching on
 * `details.precondition` got nothing from an AR double-approval, because a
 * `ConflictError` carries no details.
 *
 * OB-092 reconciled AR onto the AP spelling — the AP vocabulary won because it is
 * complete, machine-branchable, and already published. This test now asserts the
 * two vocabularies are **equal** across all four facts, the guard that they stay
 * reconciled, where it once pinned the divergence. The control is unchanged:
 * voiding a never-approved document is `document_not_approved` on all four kinds,
 * which both sides always agreed on.
 */
const db = useServiceDatabase();

const DATE = '2026-01-15';

/** What a caller can branch on, which is the whole of what is being compared. */
interface Refusal {
  readonly status: number;
  readonly code: string;
  /** `details.precondition`, or null — a `409 conflict` carries no details bag. */
  readonly precondition: string | null;
}

/** Editing/discarding an approved document — `document_approved` on both sides now. */
const editApproved: Refusal = {
  status: 412,
  code: 'precondition_failed',
  precondition: 'document_approved',
};

/** Every document one org can be put into the four refusable states with. */
interface Documents {
  readonly ctx: RequestContext;
  /** Approved and untouched: edited, discarded and re-approved are all refusals. */
  readonly approvedId: string;
  /** Approved and then voided, so voiding it again is the second attempt. */
  readonly voidedId: string;
  /** Approved with one allocation standing against it. */
  readonly allocatedId: string;
  /** Never approved, for the one token the two services already share. */
  readonly draftId: string;
}

/** The four document kinds, two per subledger. */
type DocumentKind = 'bill' | 'creditNote' | 'invoice' | 'vendorCredit';

const DOCUMENT_KINDS = [
  'invoice',
  'creditNote',
  'bill',
  'vendorCredit',
] as const satisfies readonly DocumentKind[];

/** The four operations a kind is probed with, in one shape for AR and AP. */
interface Kind {
  readonly update: (id: string, ctx: RequestContext) => Promise<unknown>;
  readonly discard: (id: string, ctx: RequestContext) => Promise<unknown>;
  readonly approve: (id: string, ctx: RequestContext) => Promise<unknown>;
  readonly void: (id: string, ctx: RequestContext) => Promise<unknown>;
}

const KINDS: Readonly<Record<DocumentKind, Kind>> = {
  invoice: {
    update: (id, ctx) => updateInvoice(id, { memo: 'Edited' }, ctx),
    discard: (id, ctx) => discardInvoice(id, ctx),
    approve: (id, ctx) => approveInvoice(id, ctx),
    void: (id, ctx) => voidInvoice(id, { date: DATE }, ctx),
  },
  creditNote: {
    update: (id, ctx) => updateCreditNote(id, { memo: 'Edited' }, ctx),
    discard: (id, ctx) => discardCreditNote(id, ctx),
    approve: (id, ctx) => approveCreditNote(id, ctx),
    void: (id, ctx) => voidCreditNote(id, { date: DATE }, ctx),
  },
  bill: {
    update: (id, ctx) => updateBill(id, { memo: 'Edited' }, ctx),
    discard: (id, ctx) => discardBill(id, ctx),
    approve: (id, ctx) => approveBill(id, ctx),
    void: (id, ctx) => voidBill(id, { date: DATE }, ctx),
  },
  vendorCredit: {
    update: (id, ctx) => updateVendorCredit(id, { memo: 'Edited' }, ctx),
    discard: (id, ctx) => discardVendorCredit(id, ctx),
    approve: (id, ctx) => approveVendorCredit(id, ctx),
    void: (id, ctx) => voidVendorCredit(id, { date: DATE }, ctx),
  },
};

/**
 * The refusal a call produced, or what it did instead.
 *
 * `'did not refuse'` rather than a thrown assertion, so a service that stopped
 * refusing altogether shows up as a row in the table beside the ones that still do
 * — which is the difference between "the vocabulary changed" and "the guard is
 * gone", and only one of those is a divergence.
 */
async function refusal(call: () => Promise<unknown>, ctx: RequestContext): Promise<unknown> {
  try {
    await runInContext(ctx, call);
    return 'did not refuse';
  } catch (error: unknown) {
    const wire = toWireError(error);
    const details = wire.details as { readonly precondition?: string } | undefined;
    return { status: wire.status, code: wire.code, precondition: details?.precondition ?? null };
  }
}

describe('the AR and AP subledgers spell four shared refusals identically (OB-092)', () => {
  it('reports each fact the same way on both sides', async () => {
    const built = await scene();

    const verdicts: Record<string, unknown> = {};
    for (const kind of DOCUMENT_KINDS) {
      const operations = KINDS[kind];
      const documents = built[kind];
      const ctx = documents.ctx;

      verdicts[`${kind}.editApproved`] = await refusal(
        () => operations.update(documents.approvedId, ctx),
        ctx,
      );
      verdicts[`${kind}.discardApproved`] = await refusal(
        () => operations.discard(documents.approvedId, ctx),
        ctx,
      );
      verdicts[`${kind}.approveTwice`] = await refusal(
        () => operations.approve(documents.approvedId, ctx),
        ctx,
      );
      verdicts[`${kind}.voidTwice`] = await refusal(
        () => operations.void(documents.voidedId, ctx),
        ctx,
      );
      verdicts[`${kind}.voidAllocated`] = await refusal(
        () => operations.void(documents.allocatedId, ctx),
        ctx,
      );
      verdicts[`${kind}.voidDraft`] = await refusal(
        () => operations.void(documents.draftId, ctx),
        ctx,
      );
    }

    const refusalOf = (precondition: string): Refusal => ({
      status: 412,
      code: 'precondition_failed',
      precondition,
    });
    const approvedTwice = refusalOf('document_already_approved');
    const alreadyVoid = refusalOf('document_already_void');
    const hasAllocations = refusalOf('document_has_allocations');
    const notApproved = refusalOf('document_not_approved');

    // The same six verdicts for every kind, AR and AP alike — which is the whole
    // point: one shape, applied four times, is the assertion that they agree.
    const shared = (prefix: string): Record<string, Refusal> => ({
      [`${prefix}.editApproved`]: editApproved,
      [`${prefix}.discardApproved`]: editApproved,
      [`${prefix}.approveTwice`]: approvedTwice,
      [`${prefix}.voidTwice`]: alreadyVoid,
      [`${prefix}.voidAllocated`]: hasAllocations,
      [`${prefix}.voidDraft`]: notApproved,
    });

    expect(verdicts).toEqual({
      ...shared('invoice'),
      ...shared('creditNote'),
      ...shared('bill'),
      ...shared('vendorCredit'),
    });
  });

  /**
   * The agreement stated as a property rather than as twenty-four literals. Before
   * OB-092 this asserted the two vocabularies were *unequal*; inverted, it is the
   * regression guard that they stay reconciled — a future divergence on either side
   * fails it, as the reconciliation itself once would have.
   */
  it('answers the three once-divergent questions identically on both sides', async () => {
    const built = await scene();
    const ar = built.invoice;
    const ap = built.bill;

    const pairs: readonly (readonly [string, unknown, unknown])[] = [
      [
        'editApproved',
        await refusal(() => KINDS.invoice.update(ar.approvedId, ar.ctx), ar.ctx),
        await refusal(() => KINDS.bill.update(ap.approvedId, ap.ctx), ap.ctx),
      ],
      [
        'approveTwice',
        await refusal(() => KINDS.invoice.approve(ar.approvedId, ar.ctx), ar.ctx),
        await refusal(() => KINDS.bill.approve(ap.approvedId, ap.ctx), ap.ctx),
      ],
      [
        'voidAllocated',
        await refusal(() => KINDS.invoice.void(ar.allocatedId, ar.ctx), ar.ctx),
        await refusal(() => KINDS.bill.void(ap.allocatedId, ap.ctx), ap.ctx),
      ],
    ];

    expect(
      pairs.map(([fact, receivable, payable]) => [
        fact,
        JSON.stringify(receivable) === JSON.stringify(payable),
      ]),
    ).toEqual([
      ['editApproved', true],
      ['approveTwice', true],
      ['voidAllocated', true],
    ]);
  });
});

/**
 * One org, four kinds, each in the four states the table probes.
 *
 * All of it through the services as an Owner, for `permission-matrix.test.ts`'s
 * reason: an approved document is a row plus a journal plus a gapless number tied
 * together by a check constraint, and a fixture that wrote those rows itself would
 * be this file's own idea of approval rather than the one the service produces —
 * which is exactly what every `void` refusal here is judged against.
 */
async function scene(): Promise<Record<DocumentKind, Documents>> {
  const org = await db.factories.org();
  const user = await db.factories.user();
  await db.factories.orgMember({
    orgId: org.id,
    userId: user.id,
    roleId: systemRoleId('owner'),
  });
  await db.factories.fiscalPeriod({ orgId: org.id });

  const [revenue, expense, bank, receivable, payable] = await Promise.all([
    db.factories.account({ orgId: org.id, code: '4000', type: 'revenue', normalBalance: 'credit' }),
    db.factories.account({ orgId: org.id, code: '5000', type: 'expense', normalBalance: 'debit' }),
    db.factories.account({ orgId: org.id, code: '1010', type: 'asset', normalBalance: 'debit' }),
    db.factories.account({ orgId: org.id, code: '1150', type: 'asset', normalBalance: 'debit' }),
    db.factories.account({
      orgId: org.id,
      code: '2050',
      type: 'liability',
      normalBalance: 'credit',
    }),
  ]);
  await db.factories.controlAccounts({
    orgId: org.id,
    receivableId: receivable.id,
    payableId: payable.id,
  });

  const ctx = contextFor(org.uuid, SYSTEM_ROLE_UUIDS.owner, user.uuid);
  const asOwner = <T>(body: () => Promise<T>): Promise<T> => runInContext(ctx, body);

  const party = await asOwner(() =>
    createContact({ displayName: 'Both Sides', isCustomer: true, isVendor: true }, ctx),
  );

  const header = { contactId: party.id, issueDate: DATE, taxMode: 'exclusive' as const };
  const arLines = [
    { description: 'Consulting', quantity: '1', unitAmount: '100000', accountId: revenue.uuid },
  ];
  const apLines = [
    { description: 'Paper', quantity: '1', unitAmount: '100000', accountId: expense.uuid },
  ];

  const makers: Readonly<Record<DocumentKind, () => Promise<string>>> = {
    invoice: async () =>
      (await asOwner(() => createInvoice({ ...header, lines: arLines }, ctx))).id,
    creditNote: async () =>
      (await asOwner(() => createCreditNote({ ...header, lines: arLines }, ctx))).id,
    bill: async () =>
      (await asOwner(() => createBill({ ...header, dueDate: DATE, lines: apLines }, ctx))).id,
    vendorCredit: async () =>
      (await asOwner(() => createVendorCredit({ ...header, lines: apLines }, ctx))).id,
  };

  /**
   * A payment on each side, ten times over what the allocations below apply.
   *
   * Over-allocating a document is refused (C3) and over-drawing the source with it,
   * and either refusal would arrive where this file expects `document_has_allocations`
   * — a wrong token that looks exactly like the reconciled fact being asserted.
   */
  const payment = async (direction: 'made' | 'received'): Promise<string> =>
    (
      await asOwner(() =>
        recordPayment(
          {
            direction,
            contactId: party.id,
            date: DATE,
            amount: '1000000',
            accountId: bank.uuid,
          },
          ctx,
        ),
      )
    ).id;

  const built = {} as Record<DocumentKind, Documents>;
  for (const kind of DOCUMENT_KINDS) {
    const make = makers[kind];
    const { approve, void: discard } = KINDS[kind];

    const approvedId = await make();
    await asOwner(() => approve(approvedId, ctx));

    const voidedId = await make();
    await asOwner(() => approve(voidedId, ctx));
    await asOwner(() => discard(voidedId, ctx));

    const allocatedId = await make();
    await asOwner(() => approve(allocatedId, ctx));

    built[kind] = { ctx, approvedId, voidedId, allocatedId, draftId: await make() };
  }

  /**
   * One allocation standing against each kind, from whichever source can reach it.
   *
   * An invoice and a bill are *targets*, settled by a payment; a credit note and a
   * vendor credit are *sources*, and what stands against them is the allocation
   * they made. Both are `selectAllocations…` on the document under test, which is
   * why one refusal covers both directions — and why a fixture that only settled
   * targets would leave the credit-note half of the table untested.
   */
  const invoiceTarget = built.invoice.allocatedId;
  const billTarget = built.bill.allocatedId;

  const received = await payment('received');
  const made = await payment('made');

  await asOwner(() =>
    allocatePayment(
      received,
      { allocations: [{ targetType: 'invoice', targetId: invoiceTarget, amount: '10000' }] },
      ctx,
    ),
  );
  await asOwner(() =>
    allocatePayment(
      made,
      { allocations: [{ targetType: 'bill', targetId: billTarget, amount: '10000' }] },
      ctx,
    ),
  );
  await asOwner(() =>
    allocateCreditNote(
      built.creditNote.allocatedId,
      { allocations: [{ targetType: 'invoice', targetId: invoiceTarget, amount: '10000' }] },
      ctx,
    ),
  );
  await asOwner(() =>
    allocateVendorCredit(
      built.vendorCredit.allocatedId,
      { allocations: [{ targetType: 'bill', targetId: billTarget, amount: '10000' }] },
      ctx,
    ),
  );

  return built;
}
