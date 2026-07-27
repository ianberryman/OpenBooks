import type { ReactElement } from 'react';

import { ApiError, presentApiError } from '../../api';

/**
 * The refusals finalising and reopening have to make legible (OB-087; ROADMAP E5, E6).
 *
 * `ErrorBanner` handles the ones whose whole content is a code and a recovery — a
 * `permission_denied` on a reopen a role may not perform reads correctly through it, because
 * the presentation layer already phrases 403 as "not available to you" (A7). What it cannot
 * phrase is the one refusal this milestone exists to be able to make: finalising when the
 * cleared balance does not equal the statement's. That arrives as a `precondition_failed`
 * carrying a stable token, and the token — not the prose — is what tells this refusal apart
 * from a closed period or any other precondition.
 *
 * The mapped message names the reconciling frame D-50 puts the two figures in: the gap is
 * `statementClosingBalance − clearedBalance`, and it is a *difference to close*, not an
 * error to correct. The server's own message states minor units; this one is the human
 * reading, and the balances panel above it shows the number.
 */
export const BALANCE_MISMATCH = 'reconciliation_session_balance_mismatch';

/**
 * `details.precondition` off an API error, narrowed rather than cast.
 *
 * `details` is `{ [key: string]: unknown }` in the generated types — OpenAPI cannot say
 * more about a free-form bag — so the chain narrows the way `fieldErrorsFrom` does in
 * `src/api/presentation.ts`. Anything unexpected reads as "no token" and the caller falls
 * back to the shared error surface.
 */
export function preconditionToken(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.code !== 'precondition_failed') return null;

  const body: unknown = error.body;
  if (typeof body !== 'object' || body === null || !('error' in body)) return null;
  const envelope: unknown = body.error;
  if (typeof envelope !== 'object' || envelope === null || !('details' in envelope)) return null;
  const details: unknown = envelope.details;
  if (typeof details !== 'object' || details === null || !('precondition' in details)) return null;

  const token: unknown = details.precondition;
  return typeof token === 'string' ? token : null;
}

export function isBalanceMismatch(error: unknown): boolean {
  return preconditionToken(error) === BALANCE_MISMATCH;
}

/**
 * The finalise refusal, rendered with the reading that makes it actionable.
 *
 * A mismatch is not a fault in the entry — it means the cleared balance and the statement
 * disagree, and the reconciler's next step is to find the clearing that is missing or wrong,
 * not to change anything on this screen. So the message points back at the difference the
 * balances panel already shows, and there is no repair button: the fix lives on the matching
 * screen (OB-086), where lines are cleared.
 */
export function FinaliseRefusal({ error }: { readonly error: unknown }): ReactElement {
  if (isBalanceMismatch(error)) {
    return (
      <div
        role="alert"
        className="flex flex-col gap-2 rounded-lg border border-warning-border bg-warning-soft p-3"
      >
        <p className="text-sm font-semibold text-warning-text">
          The books and the bank do not agree yet
        </p>
        <p className="text-sm text-text-muted">
          The cleared balance does not equal the statement&rsquo;s closing balance at the end date,
          so the reconciliation cannot be asserted. Close the difference shown above — clear the
          missing lines, or correct a clearing on the matching screen — and finalise again. An
          unpresented cheque is not this: it is a reconciling difference the report explains, not a
          reason the balances disagree.
        </p>
      </div>
    );
  }

  const presented = presentApiError(error);
  return (
    <div
      role="alert"
      className="flex flex-col gap-2 rounded-lg border border-danger-border bg-danger-soft p-3"
    >
      <p className="text-sm font-semibold text-danger-text">{presented.title}</p>
      <p className="text-sm text-text-muted">{presented.message}</p>
    </div>
  );
}
