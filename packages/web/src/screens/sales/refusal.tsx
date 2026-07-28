import type { ReactElement, ReactNode } from 'react';

import { ApiError, presentApiError } from '../../api';

/**
 * The refusals this screen has to make actionable, rendered with the detail that makes
 * them so (OB-068).
 *
 * `ErrorBanner` is the shared surface and is used everywhere the whole content is a code
 * and a recovery. It cannot serve the AR refusals, because they carry a stable token in
 * `details.precondition` that decides what the next step *is* — and three of them have a
 * next step the user can take on this very screen:
 *
 * - `document_has_allocations` — voiding is refused because allocations point at the document.
 *   The recovery is to un-apply them first, and they are listed with a button each.
 * - `receivable_control_account_not_set` / `…_unusable` — approving is refused because the
 *   org has nominated no receivables control account. The recovery is in Settings.
 * - `document_approved` — an edit or a discard arrived after someone else approved it.
 *   The recovery is to reload and look at what it now is.
 *
 * Title and message still come from `presentApiError`, so a 404 or a 409 reads the same
 * here as everywhere else and this file holds no second opinion about what a code means.
 * What it adds is the token and the affordance.
 */
export interface RefusalProps {
  readonly error: unknown;
  /** Buttons for the recovery the caller can offer. Rendered under the message. */
  readonly children?: ReactNode;
}

export function Refusal({ error, children }: RefusalProps): ReactElement {
  const presented = presentApiError(error);

  return (
    <div
      role="alert"
      className="flex flex-col gap-2 rounded-lg border border-danger-border bg-danger-soft p-3"
    >
      <p className="text-sm font-semibold text-danger-text">{presented.title}</p>
      <p className="text-sm text-text-muted">{presented.message}</p>
      {children !== undefined && <div className="flex flex-col gap-2 pt-1">{children}</div>}
    </div>
  );
}

/**
 * `details` off an API error, narrowed rather than cast.
 *
 * The generated type is `{ [key: string]: unknown }` — OpenAPI cannot say more about a
 * free-form bag — so a screen that trusted its shape would be trusting a description
 * rather than a check.
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
 * The stable token naming which precondition failed.
 *
 * Branched on rather than the prose, because `packages/server/src/errors/codes.ts` makes
 * the token the part of the contract that is never renamed. The prose is still what the
 * user reads; this only decides which recovery to put next to it.
 */
export function preconditionToken(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.code !== 'precondition_failed') return null;

  const details = errorDetails(error);
  if (details === null || !('precondition' in details)) return null;

  const token: unknown = details.precondition;
  return typeof token === 'string' ? token : null;
}

/**
 * Whether this refusal is "there are allocations against it", which is the one void
 * refusal with a fix on this screen.
 *
 * The rule behind it is worth knowing rather than merely obeying: voiding reverses the
 * document's journal, so an allocation left pointing at a voided document would read as a
 * payment fully applied against a receivable that no longer exists — the subledger and the
 * control account would disagree by exactly the amount applied, which is C2's failure
 * caused by the operation meant to correct things.
 */
export function isAllocatedRefusal(error: unknown): boolean {
  return preconditionToken(error) === 'document_has_allocations';
}
