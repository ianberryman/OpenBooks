import type { PaymentRail, RailDisbursement, RailDisbursementList } from '@openbooks/shared-types';
import { fromMinorUnits, toMinorString } from '@openbooks/shared-types/money';

import { getContext } from '../../context';
import type { RequestContext } from '../../context';
import type { TenantDatabase } from '../../db';
import { bufferToUuid, orgScope as toOrgId, tenantDb } from '../../db';
import { requirePermission } from '../permissions';

/**
 * The list-by-rail read (OB-114; ROADMAP D-110): every disbursement issued on
 * one rail, so an external ACH/wire system can pull the batch it is responsible
 * for moving. OpenBooks generates no NACHA file and executes no wire itself —
 * this is the whole handoff surface, and it exists precisely because the
 * movement happens somewhere else.
 *
 * Gated `disbursements.issue`, not `pending_payments.read`. The queue-read
 * permission shows a clerk what is queued; this shows a vendor's real ACH
 * routing/account number or wire instructions to whoever calls it, which is
 * squarely the "release" authority (D-109) and seeded owner-only for the same
 * reason issuing itself is — a clerk who can build the queue should not be able
 * to exfiltrate every vendor's bank coordinates by switching the rail filter.
 *
 * The join is `pending_payments` (the only place `rail` lives once issued) →
 * its `issued_payment_id` in `payments` (the amount, the reference, the
 * instant) → `contacts` (the vendor name and its bank coordinates, D-67). A
 * `pending_payment` never reaches `status = 'issued'` without an
 * `issued_payment_id` (`issuePendingPayment` sets both together in one
 * transaction), so the inner joins below drop nothing this filter should show.
 */

interface RailDisbursementRow {
  readonly payment_id: Buffer;
  readonly contact_id: Buffer;
  readonly vendor_name: string;
  readonly rail: PaymentRail;
  readonly amount_minor: bigint;
  readonly reference: string | null;
  readonly ach_routing_number: string | null;
  readonly ach_account_number: string | null;
  readonly wire_instructions: string | null;
  readonly issued_at: Date;
}

function orgScope(ctx: RequestContext): TenantDatabase {
  return tenantDb(toOrgId(ctx.orgId));
}

/**
 * Every joined tenant table repeats the org predicate explicitly
 * (`onRef(...org_id..., ...org_id...)`), matching `general-ledger.repository.ts`'s
 * `selectCounterpartyLines`: `tenantDb` only scopes the table named in
 * `selectFrom`, so a join across three tenant tables needs the equality stated
 * at each join or the query would compile without actually confining the
 * joined rows to this org.
 */
async function selectIssuedByRail(
  db: TenantDatabase,
  rail: PaymentRail,
): Promise<readonly RailDisbursementRow[]> {
  return db
    .selectFrom('pending_payments')
    .innerJoin('payments', (join) =>
      join
        .onRef('payments.id', '=', 'pending_payments.issued_payment_id')
        .onRef('payments.org_id', '=', 'pending_payments.org_id'),
    )
    .innerJoin('contacts', (join) =>
      join
        .onRef('contacts.id', '=', 'payments.contact_id')
        .onRef('contacts.org_id', '=', 'payments.org_id'),
    )
    .where('pending_payments.status', '=', 'issued')
    .where('pending_payments.rail', '=', rail)
    .orderBy('payments.created_at', 'asc')
    .orderBy('payments.id', 'asc')
    .select([
      'payments.id as payment_id',
      'payments.contact_id as contact_id',
      'contacts.display_name as vendor_name',
      'pending_payments.rail as rail',
      'payments.amount_minor as amount_minor',
      'payments.reference as reference',
      'contacts.ach_routing_number as ach_routing_number',
      'contacts.ach_account_number as ach_account_number',
      'contacts.wire_instructions as wire_instructions',
      'payments.created_at as issued_at',
    ])
    .execute();
}

function toRailDisbursement(row: RailDisbursementRow): RailDisbursement {
  return {
    paymentId: bufferToUuid(row.payment_id),
    contactId: bufferToUuid(row.contact_id),
    vendorName: row.vendor_name,
    rail: row.rail,
    amount: toMinorString(fromMinorUnits(row.amount_minor)),
    reference: row.reference,
    achRoutingNumber: row.ach_routing_number,
    achAccountNumber: row.ach_account_number,
    wireInstructions: row.wire_instructions,
    issuedAt: row.issued_at.toISOString(),
  };
}

export async function listDisbursementsByRail(
  rail: PaymentRail,
  ctx: RequestContext = getContext('listDisbursementsByRail()'),
): Promise<RailDisbursementList> {
  await requirePermission(ctx, 'disbursements.issue');

  const rows = await selectIssuedByRail(orgScope(ctx), rail);
  return { disbursements: rows.map(toRailDisbursement) };
}
