import type {
  PaymentRail,
  UpdateVendorDisbursementDetailsRequest,
  VendorDisbursementDetails,
} from '@openbooks/shared-types';
import { updateVendorDisbursementDetailsRequestSchema } from '@openbooks/shared-types';

import { getContext } from '../../context';
import type { RequestContext } from '../../context';
import type { TenantDatabase } from '../../db';
import { orgScope as toOrgId, tenantDb, tryUuidToBuffer } from '../../db';
import { assertFound, parseInput } from '../../errors';
import { requirePermission } from '../permissions';

/**
 * A vendor's disbursement details (OB-114; ROADMAP D-67, D-110): the four
 * `contacts` columns Pay Bills reads to pick a rail default and the coordinates
 * an `ach`/`wire` handoff needs (`rail-disbursements.service.ts` is the read that
 * hands them to the external system that actually moves money).
 *
 * This file owns a narrow slice of the `contacts` table rather than reusing
 * `contacts.repository.ts`'s whole-row `selectContactById` — the same choice
 * `banking/rules/rules.repository.ts` makes for its own `contacts` touchpoint:
 * a module that only ever reads or writes four disbursement columns has no use
 * for the other twenty, and defines its own local resource token rather than
 * importing one, so a change to the contacts module's own 404 shape cannot
 * silently change what this module reports.
 *
 * `contacts.read`/`contacts.write` gate this, not a Pay-Bills-specific key —
 * these are contact fields (D-67), not pending-payment or disbursement state, so
 * the existing contact permissions are the right authority. A cross-org contact
 * id is a miss, not a leak (A7): `orgScope` confines every statement below to
 * the caller's org before `assertFound` turns the miss into the one error this
 * module is allowed to produce.
 */

/** The resource token every miss in this module reports (A7). */
export const CONTACT_RESOURCE = 'contact';

interface DisbursementRow {
  readonly preferred_payment_rail: PaymentRail | null;
  readonly ach_routing_number: string | null;
  readonly ach_account_number: string | null;
  readonly wire_instructions: string | null;
}

const DISBURSEMENT_COLUMNS = [
  'preferred_payment_rail',
  'ach_routing_number',
  'ach_account_number',
  'wire_instructions',
] as const;

function orgScope(ctx: RequestContext): TenantDatabase {
  return tenantDb(toOrgId(ctx.orgId));
}

/**
 * A client-supplied contact id as bytes, or `undefined` when it is not a UUID.
 *
 * Undefined rather than a throw, so the caller routes a malformed id through
 * `assertFound` to the same 404 a nonexistent or cross-org one reaches — a `400`
 * here would be a distinguishable answer for a class of ids, which A7 rules out.
 */
function contactIdBytes(contactId: string): Buffer | undefined {
  return tryUuidToBuffer(contactId);
}

async function selectDisbursementRow(
  db: TenantDatabase,
  id: Buffer,
): Promise<DisbursementRow | undefined> {
  return db
    .selectFrom('contacts')
    .select(DISBURSEMENT_COLUMNS)
    .where('id', '=', id)
    .executeTakeFirst();
}

function toVendorDisbursementDetails(row: DisbursementRow): VendorDisbursementDetails {
  return {
    preferredPaymentRail: row.preferred_payment_rail,
    achRoutingNumber: row.ach_routing_number,
    achAccountNumber: row.ach_account_number,
    wireInstructions: row.wire_instructions,
  };
}

export async function getVendorDisbursementDetails(
  contactId: string,
  ctx: RequestContext = getContext('getVendorDisbursementDetails()'),
): Promise<VendorDisbursementDetails> {
  await requirePermission(ctx, 'contacts.read');

  const db = orgScope(ctx);
  const id = assertFound(contactIdBytes(contactId), CONTACT_RESOURCE);

  return toVendorDisbursementDetails(
    assertFound(await selectDisbursementRow(db, id), CONTACT_RESOURCE),
  );
}

/**
 * Sets or clears a vendor's disbursement details. `null` clears a field, an
 * absent one leaves it alone — `updateVendorDisbursementDetailsRequestSchema`'s
 * `.nullish()` shape, mirrored here exactly as `updateContactRow` mirrors
 * `updateContactRequestSchema`'s.
 *
 * No row lock: unlike `updateContact`'s `code`, none of these four columns is
 * unique, so two concurrent updates cannot race a constraint — the later write
 * simply wins, the same "last write wins" `setActive` accepts for `isActive`.
 */
export async function updateVendorDisbursementDetails(
  contactId: string,
  input: UpdateVendorDisbursementDetailsRequest,
  ctx: RequestContext = getContext('updateVendorDisbursementDetails()'),
): Promise<VendorDisbursementDetails> {
  await requirePermission(ctx, 'contacts.write');
  const request = parseInput(updateVendorDisbursementDetailsRequestSchema, input);

  const db = orgScope(ctx);
  const id = assertFound(contactIdBytes(contactId), CONTACT_RESOURCE);
  assertFound(await selectDisbursementRow(db, id), CONTACT_RESOURCE);

  await db
    .updateTable('contacts')
    .set({
      // `undefined` leaves the column alone (a `.set()` with the key omitted);
      // `null` clears it. `request` already carries exactly that distinction —
      // `.nullish()` on the wire schema — so it is restated per column rather
      // than resolved once, the same shape `updateContactRow` uses.
      ...(request.preferredPaymentRail === undefined
        ? {}
        : { preferred_payment_rail: request.preferredPaymentRail }),
      ...(request.achRoutingNumber === undefined
        ? {}
        : { ach_routing_number: request.achRoutingNumber }),
      ...(request.achAccountNumber === undefined
        ? {}
        : { ach_account_number: request.achAccountNumber }),
      ...(request.wireInstructions === undefined
        ? {}
        : { wire_instructions: request.wireInstructions }),
    })
    .where('id', '=', id)
    .execute();

  return toVendorDisbursementDetails(
    assertFound(await selectDisbursementRow(db, id), CONTACT_RESOURCE),
  );
}
