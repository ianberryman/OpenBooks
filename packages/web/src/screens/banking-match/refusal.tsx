import type { ReactElement, ReactNode } from 'react';

import { ApiError, presentApiError } from '../../api';

/**
 * The clearings this screen has to make legible when they are refused (ROADMAP M4; E4, E7).
 *
 * A clear can be refused for a reason the state, not the entry, holds, and each arrives as a
 * `412` carrying a stable token in `details.precondition` — the part of the contract
 * `packages/server/src/errors/codes.ts` never renames. The server's prose (via
 * `presentApiError`) is the title and the fallback; this file adds the one sentence that
 * says what the state *is* and where the way forward lies, keyed on the token rather than
 * the prose:
 *
 * - `period_closed` — the line's date, or the reversal's, falls in a closed fiscal period.
 * - `statement_line_already_cleared` — someone cleared it since the page was drawn
 *   (`uq_blc_line` — a line clears once).
 * - `reconciliation_session_already_finalised` — the line sits in a finalised session; the
 *   way back is a reopen (E6).
 * - `clearing_difference_unaccounted` — the entry does not equal the line and the difference
 *   has nowhere to post (E4).
 * - `statement_line_not_cleared` — an undo arrived for a line nothing had cleared.
 */
const REFUSAL_MESSAGE: Readonly<Record<string, string>> = {
  period_closed:
    'This falls in a closed accounting period. Reopen the period, or use a date inside an open one.',
  statement_line_already_cleared:
    'This line has already been cleared — someone matched it since this page was loaded. Reload to see how it now stands.',
  reconciliation_session_already_finalised:
    'This line belongs to a reconciliation that has been finalised. Reopen that reconciliation before changing it.',
  clearing_difference_unaccounted:
    'The entry does not equal the line, and the difference has nowhere to go. Choose an account for it — a bank charge or a short payment — and try again.',
  statement_line_not_cleared:
    'This line was not cleared, so there is nothing to undo. Reload to see how it now stands.',
};

/**
 * The stable token naming which precondition failed, narrowed rather than cast.
 *
 * `details` is `{ [key: string]: unknown }` in the generated types — OpenAPI cannot say more
 * about a free-form bag — so the chain walks it the way `sales/refusal.tsx` and
 * `presentation.ts` do. Anything unexpected reads as "no token" and the caller falls back to
 * the server's own message.
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

/** The mapped sentence for a refusal, or null when it is not one of ours. */
export function refusalGuidance(error: unknown): string | null {
  const token = preconditionToken(error);
  return token === null ? null : (REFUSAL_MESSAGE[token] ?? null);
}

export interface MatchRefusalProps {
  readonly error: unknown;
  readonly children?: ReactNode;
}

/**
 * A refused clear, as something the user can act on.
 *
 * Title and message come from `presentApiError`, so a 404 or a 409 reads the same here as
 * everywhere else and this file holds no second opinion about what a code means. What it
 * adds is the token-specific guidance beneath it, when the refusal is one of the five this
 * screen understands.
 */
export function MatchRefusal({ error, children }: MatchRefusalProps): ReactElement {
  const presented = presentApiError(error);
  const guidance = refusalGuidance(error);

  return (
    <div
      role="alert"
      className="flex flex-col gap-2 rounded-lg border border-danger-border bg-danger-soft p-3"
    >
      <p className="text-sm font-semibold text-danger-text">{presented.title}</p>
      <p className="text-sm text-text-muted">{guidance ?? presented.message}</p>
      {children !== undefined && <div className="flex flex-col gap-2 pt-1">{children}</div>}
    </div>
  );
}
