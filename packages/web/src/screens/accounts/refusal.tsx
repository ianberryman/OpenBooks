import type { ReactElement, ReactNode } from 'react';

import { ApiError, presentApiError } from '../../api';

/**
 * A refusal this screen has to make actionable, rendered with its structured detail.
 *
 * `ErrorBanner` is the shared surface and is used for the list's own failures, where the
 * whole content is a code and a recovery. It cannot serve the two refusals this screen
 * exists to make legible, because both carry *detail* the user has to read in order to
 * act: `conflict` from a template application names every colliding code in
 * `details.codes`, and `precondition_failed` names which precondition failed in
 * `details.precondition`, which is what decides whether the next step is "deactivate
 * instead" or "detach the children first".
 *
 * Title and message still come from `presentApiError`, so the wording of a 404 or a 409 is
 * the same here as everywhere else and this file holds no second opinion about what an
 * error code means. What it adds is the detail and the affordance.
 */
export interface RefusalProps {
  readonly error: unknown;
  /** Buttons for the recovery the caller can offer. Rendered under the message. */
  readonly children?: ReactNode;
}

export function Refusal({ error, children }: RefusalProps): ReactElement {
  const presented = presentApiError(error);
  const codes = collidingCodes(error);

  return (
    <div
      role="alert"
      className="flex flex-col gap-2 rounded-lg border border-danger-border bg-danger-soft p-3"
    >
      <p className="text-sm font-semibold text-danger-text">{presented.title}</p>
      <p className="text-sm text-text-muted">{presented.message}</p>

      {codes !== null && (
        <ul className="flex flex-wrap gap-1" aria-label="Account codes already in use">
          {codes.map((code) => (
            <li
              key={code}
              className="rounded-sm border border-danger-border bg-surface px-1.5 py-0.5 font-mono text-xs text-text"
            >
              {code}
            </li>
          ))}
        </ul>
      )}

      {children !== undefined && <div className="flex flex-wrap gap-2 pt-1">{children}</div>}
    </div>
  );
}

/**
 * `details` off an API error, narrowed rather than cast.
 *
 * The generated type is `{ [key: string]: unknown }` — OpenAPI cannot say more about a
 * free-form bag — so a screen that trusted its shape would be trusting a description. The
 * chain below is the same one `fieldErrorsFrom` walks in `src/api/presentation.ts`.
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
 * The account codes a chart template collided with, or `null` when this is not that error.
 *
 * Sorted by the server and safe to display: `uq_accounts_org_code` is `(org_id, code)`, so
 * every code named belongs to the caller's own org (D-23, `codesAlreadyInUseError`).
 */
export function collidingCodes(error: unknown): readonly string[] | null {
  if (!(error instanceof ApiError) || error.code !== 'conflict') return null;

  const details = errorDetails(error);
  if (details === null || !('codes' in details)) return null;

  const codes: unknown = details.codes;
  if (!Array.isArray(codes)) return null;

  const strings = codes.filter((code): code is string => typeof code === 'string');
  return strings.length === 0 ? null : strings;
}

/**
 * The stable token naming which precondition failed — `account_has_postings`,
 * `account_has_children`, `account_parent_type_mismatch`, `account_parent_cycle`,
 * `account_depth_exceeded`.
 *
 * Branched on rather than the prose, because `src/errors/codes.ts` makes the token the
 * part of the contract that is never renamed. The prose is still what the user reads;
 * this only decides which recovery to put next to it.
 */
export function preconditionToken(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.code !== 'precondition_failed') return null;

  const details = errorDetails(error);
  if (details === null || !('precondition' in details)) return null;

  const token: unknown = details.precondition;
  return typeof token === 'string' ? token : null;
}
