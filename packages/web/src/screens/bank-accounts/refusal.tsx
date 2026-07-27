import type { ReactElement } from 'react';

import { ApiError, presentApiError } from '../../api';

/**
 * The one refusal bank-account setup has to make legible (OB-095; E6, D-45).
 *
 * Deactivating an account with an open reconciliation session is refused with a
 * `precondition_failed` carrying a stable token — `bank_account_has_open_session` — and the
 * token, not the prose, is what tells this refusal apart from any other precondition. Every
 * other refusal this screen can meet (a `permission_denied`, a `validation_failed`) is
 * already phrased by the shared presentation layer, so only this one needs a reading of its
 * own: it is a *sequence* problem, not a bad request. Finalise or reopen-and-close the
 * session first, then the account can be deactivated.
 */
export const HAS_OPEN_SESSION = 'bank_account_has_open_session';

/**
 * `details.precondition` off an API error, narrowed rather than cast — the same chain
 * `reconciliation/refusal.tsx` walks, because `details` is `{ [key: string]: unknown }` in
 * the generated types and OpenAPI cannot say more about a free-form bag. Anything
 * unexpected reads as "no token" and the caller falls back to the shared error surface.
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

export function isOpenSessionRefusal(error: unknown): boolean {
  return preconditionToken(error) === HAS_OPEN_SESSION;
}

/**
 * A deactivation refusal, rendered with the reading that makes it actionable, or the shared
 * error surface for anything else.
 *
 * An open session is not a fault in the account — the account is fine, the timing is wrong —
 * so the message points at the session and its next step, and there is no repair button:
 * finalising or reopening a session lives on the reconciliation screen (OB-087), not here.
 */
export function DeactivateRefusal({ error }: { readonly error: unknown }): ReactElement {
  if (isOpenSessionRefusal(error)) {
    return (
      <div
        role="alert"
        className="flex flex-col gap-2 rounded-lg border border-warning-border bg-warning-soft p-3"
      >
        <p className="text-sm font-semibold text-warning-text">
          This account has a reconciliation open
        </p>
        <p className="text-sm text-text-muted">
          A deactivated account can settle no clearing, so an open reconciliation session would be
          stranded with lines it could never clear. Finalise the session, or reopen and close it, on
          the reconciliation screen &mdash; then deactivate the account here.
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
