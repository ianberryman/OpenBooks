import type { ReactElement } from 'react';

import { ApiError, presentApiError } from '../../api';
import { Button } from '../../components';

/**
 * The one refusal on this screen that is not an error message (OB-069; D-36).
 *
 * ## Why this is a question
 *
 * `approveBill` refuses a second approved, un-voided bill from one vendor quoting one of
 * that vendor's invoice numbers, with `duplicate_vendor_reference`. That check exists
 * because two live bills under one supplier number is how a supplier gets paid twice, and
 * neither the totals nor the trial balance shows anything wrong — both bills are
 * individually correct. It fires **only at approval, never on a draft**: a check that
 * fired while someone was typing is a check they learn to work around, and D-38 keeps a
 * draft freely editable up to the irreversible step.
 *
 * What arrives, then, is not a malformed field. It is the system saying *we appear to
 * already have this*, and the user is the only one who can say whether that is true. A
 * red "invalid" box invites the reflex that answers a validation error — change the value
 * until the box goes away — and the value a user would change is the vendor's number,
 * which is the one field on the document they are not entitled to invent. So this renders
 * as a question with the three real answers next to it:
 *
 *  - **it is the same bill** — open the one already approved and discard this draft;
 *  - **the earlier one was a mistake** — void it, after which this number is free again,
 *    because the refusal deliberately ignores voided bills;
 *  - **the vendor really issued two documents under one number** — that is the vendor's
 *    error, and an AP clerk should be calling them rather than filing it silently.
 *
 * The first is the recovery this component can act on directly, and it is why
 * `GET /v1/bills` takes a `reference` filter at all.
 *
 * The prose under the question is the **server's**, not a second opinion written here:
 * `PreconditionFailedError`'s message names the colliding bill's number, which it is
 * allowed to do because the colliding row is inside the caller's own org by construction
 * (unlike `NotFoundError`, which takes a token and nothing else).
 */
export interface DuplicateVendorReferenceProps {
  readonly error: unknown;
  readonly vendorName: string;
  readonly reference: string;
  readonly onFindExisting: () => void;
  readonly onEditReference: () => void;
}

export function DuplicateVendorReference({
  error,
  vendorName,
  reference,
  onFindExisting,
  onEditReference,
}: DuplicateVendorReferenceProps): ReactElement {
  const presented = presentApiError(error);

  return (
    <div
      role="alert"
      className="flex flex-col gap-2 rounded-lg border border-warning-border bg-warning-soft p-3"
    >
      <p className="text-sm font-semibold text-warning-text">
        Have you already entered this {vendorName} invoice?
      </p>
      <p className="text-sm text-text-muted">
        You already have an approved bill from {vendorName} quoting invoice number{' '}
        <span className="font-mono text-text">{reference}</span>. Nothing has been approved.
      </p>
      <p className="text-sm text-text-muted">{presented.message}</p>
      <p className="text-sm text-text-muted">
        If the earlier bill was entered by mistake, void it — this number is free again once it is,
        because the check ignores voided bills. If the vendor genuinely issued two documents under
        one number, ask them to correct it.
      </p>

      <div className="flex flex-wrap gap-2 pt-1">
        <Button size="sm" variant="primary" onClick={onFindExisting}>
          Show the bill with this number
        </Button>
        <Button size="sm" onClick={onEditReference}>
          Correct the vendor’s number
        </Button>
      </div>
    </div>
  );
}

/**
 * `details` off an API error, narrowed rather than cast.
 *
 * The generated type is `{ [key: string]: unknown }` — OpenAPI cannot say more about a
 * free-form bag — so a screen that trusted its shape would be trusting a description.
 * Spelled locally rather than imported from another screen's module: the narrowing is
 * eight lines and a cross-screen import is a coupling neither ticket agreed to.
 */
function errorDetails(error: unknown): object | null {
  if (!(error instanceof ApiError)) return null;

  const body: unknown = error.body;
  if (typeof body !== 'object' || body === null || !('error' in body)) return null;

  const envelope: unknown = body.error;
  if (typeof envelope !== 'object' || envelope === null || !('details' in envelope)) return null;

  const details: unknown = envelope.details;
  if (typeof details !== 'object' || details === null) return null;

  return details;
}

/**
 * The stable token naming which precondition failed — `duplicate_vendor_reference`,
 * `document_has_allocations`, `payable_control_account_not_set`, `document_approved`.
 *
 * Branched on rather than the prose, because `src/errors/codes.ts` makes the token the
 * part of the contract that is never renamed. The prose is still what the user reads.
 */
export function preconditionToken(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.code !== 'precondition_failed') return null;

  const details = errorDetails(error);
  if (details === null || !('precondition' in details)) return null;

  const token: unknown = details.precondition;
  return typeof token === 'string' ? token : null;
}

export const DUPLICATE_VENDOR_REFERENCE = 'duplicate_vendor_reference';

export function isDuplicateVendorReference(error: unknown): boolean {
  return preconditionToken(error) === DUPLICATE_VENDOR_REFERENCE;
}
