import type { ReactElement } from 'react';

import {
  Button,
  ErrorBanner,
  MoneyInput,
  ResponsiveTable,
  formatMinorUnits,
} from '../../components';
import { Amount, exceeds, isZeroAmount, subtractMinorUnits, sumMinorUnits } from './amounts';
import type { OpenDocument } from './queries';
import {
  DOCUMENT_OVER_ALLOCATED,
  SOURCE_OVER_ALLOCATED,
  preconditionToken,
  useDiscountSuggestion,
} from './queries';

/**
 * Choosing what a payment settles, and how much of it (OB-070; ROADMAP D-37, D-39).
 *
 * ## The two rules this form has to make legible, and they are not the same rule
 *
 * **Over-allocating a document is refused** (C3): allocations against one invoice may not
 * exceed it, because that is a claim the invoice was settled twice and it puts the
 * subledger out of agreement with the ledger. **Over-paying is fine**: a payment larger
 * than everything it settles leaves credit on the contact, which is an ordinary Tuesday.
 *
 * The asymmetry is the point, so the form states both sides rather than enforcing one and
 * hiding the other. A row asking for more than its document has outstanding is marked as it
 * is typed; a batch that comes to less than the payment says so in the footer, in the words
 * "stays as credit on the contact" and not in the words of a validation error.
 *
 * ## Why the row warning does not disable the button
 *
 * `outstanding` here is the server's figure, read when this list was fetched. Another user
 * may have applied a credit note against the same invoice since (D-39 — a credit note
 * reduces a document through these same rows), so the number on screen can be stale by the
 * time Apply is pressed. The refusal that matters is therefore the server's, under a lock,
 * and this screen's job is to render it so the user can act — which is what
 * `AllocationRefusal` below is for. A disabled button would trade a legible refusal for a
 * dead end whenever the client's copy was the wrong one in the other direction.
 */

export interface AllocationDraft {
  readonly documentId: string;
  /** Cents-only minor units (D-13). A row with no amount is not a draft at all. */
  readonly amount: string;
}

export function draftFor(
  drafts: readonly AllocationDraft[],
  documentId: string,
): AllocationDraft | undefined {
  return drafts.find((draft) => draft.documentId === documentId);
}

export function withDraft(
  drafts: readonly AllocationDraft[],
  documentId: string,
  amount: string | null,
): readonly AllocationDraft[] {
  const without = drafts.filter((draft) => draft.documentId !== documentId);
  return amount === null || isZeroAmount(amount) ? without : [...without, { documentId, amount }];
}

export function draftedTotal(drafts: readonly AllocationDraft[]): string {
  return sumMinorUnits(drafts.map((draft) => draft.amount));
}

/**
 * The repair the over-allocation refusal offers: each offending row falls back to what its
 * document has outstanding, and the difference stays where D-37 puts it — on the contact.
 */
export function reduceToOutstanding(
  drafts: readonly AllocationDraft[],
  documents: readonly { readonly id: string; readonly outstanding: string }[],
): readonly AllocationDraft[] {
  return drafts.reduce<readonly AllocationDraft[]>((accumulated, draft) => {
    const document = documents.find((candidate) => candidate.id === draft.documentId);
    if (document === undefined) return accumulated;
    return withDraft(
      accumulated,
      draft.documentId,
      exceeds(draft.amount, document.outstanding) ? document.outstanding : draft.amount,
    );
  }, drafts);
}

/** The rows asking for more than the document was last known to have outstanding. */
export function overAllocatedDrafts(
  drafts: readonly AllocationDraft[],
  documents: readonly OpenDocument[],
): readonly { readonly document: OpenDocument; readonly asked: string }[] {
  return drafts.flatMap((draft) => {
    const document = documents.find((candidate) => candidate.id === draft.documentId);
    if (document === undefined || !exceeds(draft.amount, document.outstanding)) return [];
    return [{ document, asked: draft.amount }];
  });
}

export interface AllocationEditorProps {
  readonly documents: readonly OpenDocument[];
  readonly drafts: readonly AllocationDraft[];
  readonly onChange: (drafts: readonly AllocationDraft[]) => void;
  /** What the source has left to apply — the payment's own `settlement.outstanding`. */
  readonly available: string;
  readonly isPending: boolean;
  readonly emptyMessage: string;
  /**
   * The date the early-pay discount window (D-79) is evaluated against — "if this were
   * settled today". The date this payment moved, not the day someone gets round to
   * applying it, so a receipt entered late still sees the discount it was actually
   * eligible for on arrival.
   */
  readonly asOfDate: string;
}

export function AllocationEditor({
  documents,
  drafts,
  onChange,
  available,
  isPending,
  emptyMessage,
  asOfDate,
}: AllocationEditorProps): ReactElement {
  const applied = draftedTotal(drafts);
  const remainder = subtractMinorUnits(available, applied);

  if (documents.length === 0) {
    return <p className="text-sm text-text-muted">{emptyMessage}</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      <ResponsiveTable>
        <table className="w-full border-collapse text-base">
          <caption className="sr-only">Open documents this payment can settle</caption>
          <thead>
            <tr className="border-b border-border text-left text-sm text-text-muted">
              <th scope="col" className="py-1 pr-3 font-medium">
                Document
              </th>
              <th scope="col" className="py-1 pr-3 font-medium">
                Due
              </th>
              <th scope="col" className="py-1 pr-3 text-right font-medium">
                Outstanding
              </th>
              <th scope="col" className="py-1 text-right font-medium">
                Apply
              </th>
            </tr>
          </thead>
          <tbody>
            {documents.map((document) => {
              const draft = draftFor(drafts, document.id);
              const over = draft !== undefined && exceeds(draft.amount, document.outstanding);

              return (
                <tr key={document.id} className="border-b border-border align-top">
                  <td className="py-1 pr-3 font-mono text-sm text-text">{document.number}</td>
                  <td className="py-1 pr-3 font-mono text-sm text-text-muted">
                    {document.dueDate}
                  </td>
                  <td className="py-1 pr-3 text-right">
                    <Amount value={document.outstanding} />
                  </td>
                  <td className="py-1">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={isPending}
                        aria-label={`Apply the full ${document.number} outstanding`}
                        onClick={() => {
                          onChange(withDraft(drafts, document.id, document.outstanding));
                        }}
                      >
                        In full
                      </Button>
                      <MoneyInput
                        className="w-32"
                        aria-label={`Amount to apply to ${document.number}`}
                        value={draft?.amount ?? null}
                        disabled={isPending}
                        onValueChange={(amount) => {
                          onChange(withDraft(drafts, document.id, amount));
                        }}
                      />
                    </div>
                    {over && (
                      <p className="pt-1 text-right text-xs text-warning-text">
                        More than the <Amount value={document.outstanding} /> outstanding. The
                        server refuses an over-allocated document; over-paying is fine and lands
                        as credit.
                      </p>
                    )}
                    {document.targetType === 'invoice' && (
                      <DiscountHint targetId={document.id} asOfDate={asOfDate} />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </ResponsiveTable>

      <AllocationFooter applied={applied} available={available} remainder={remainder} />
    </div>
  );
}

/**
 * The terms-driven discount suggestion (OB-138; ROADMAP D-79, D-81, D-108), surfaced for
 * an invoice the way `multi-entry-dialog.tsx` surfaces it on the bank-match workbench —
 * "the money-in screen remains for receipts not in the feed" is D-81's own words for why
 * this screen needs the same suggestion the workbench does.
 *
 * ## Informational only, and the reason is a real gap rather than a design choice
 *
 * Confirming a discount is a `discount`-kind allocation funded by its own posted journal
 * (D-106) — a write `clearBankStatementLine`'s `discount` entry performs for a line in the
 * feed. Nothing in this API records that same write for a *manual* receipt yet
 * (`modules/banking/clearing` is, today, the one caller of `AllocationSource`'s `'discount'`
 * kind). So this hint states the suggestion — the amount, and the deadline to take it by —
 * and stops there rather than offering an "Apply discount" button with nowhere to post: a
 * control that looked actionable and silently did nothing would be worse than no control at
 * all. Confirming one here is a follow-up once a manual-receipt discount route exists.
 *
 * A `204` (no term, a simple term, or the window has passed) renders nothing, which is the
 * ordinary case and not a failure — most invoices are not mid-discount-window.
 */
function DiscountHint({
  targetId,
  asOfDate,
}: {
  readonly targetId: string;
  readonly asOfDate: string;
}): ReactElement | null {
  const suggestion = useDiscountSuggestion('invoice', targetId, asOfDate);

  if (suggestion.data === null || suggestion.data === undefined) return null;

  return (
    <p className="pt-1 text-right text-xs text-accent">
      Eligible for an early-pay discount of{' '}
      <span className="font-mono tabular-nums">
        {formatMinorUnits(suggestion.data.discountAmountMinor)}
      </span>{' '}
      if settled by {suggestion.data.deadline}.
    </p>
  );
}

/**
 * What the batch comes to, and what is left over — stated as a fact and not as a fault.
 *
 * D-37: "an unallocated remainder is a credit balance on the contact, applicable later".
 * A remainder is the ordinary outcome of a deposit that arrives before anyone has decided
 * what it settles, so this line reads as an account of where the money is.
 */
function AllocationFooter({
  applied,
  available,
  remainder,
}: {
  readonly applied: string;
  readonly available: string;
  readonly remainder: string;
}): ReactElement {
  const overSource = exceeds(applied, available);

  return (
    <p className="text-sm text-text-muted">
      Applying <Amount value={applied} /> of the <Amount value={available} /> this payment has left.{' '}
      {overSource ? (
        <span className="text-warning-text">
          That is more than the payment holds. A payment can settle only what it was for — recording
          more money is what makes more available.
        </span>
      ) : isZeroAmount(remainder) ? (
        <span>Nothing is left over.</span>
      ) : (
        <span>
          <Amount value={remainder} /> stays as credit on the contact, applicable to anything later.
        </span>
      )}
    </p>
  );
}

export interface AllocationRefusalProps {
  readonly error: unknown;
  readonly drafts: readonly AllocationDraft[];
  readonly documents: readonly OpenDocument[];
  readonly available: string;
  /** Rewrites the offending rows down to what each document has outstanding. */
  readonly onReduceToOutstanding: () => void;
  readonly onDismiss: () => void;
}

/**
 * A refusal this screen has to make actionable, rather than a red box that ends the
 * enquiry.
 *
 * `document_over_allocated` is the refusal OB-070 exists to make legible. The server's own
 * message names the amounts in **minor units** — it is written for an integrator reading
 * JSON, and "50000 minor units" on screen would be read as fifty thousand pounds — so this
 * one is rewritten from figures the screen already holds, formatted through
 * `formatMinorUnits` (D-13). What it adds beyond wording is the recovery: one button that
 * reduces each offending row to what its document has outstanding, leaving the difference
 * where D-37 says it belongs, as credit on the contact.
 *
 * Anything this does not recognise falls through to `ErrorBanner`, so a 404 or a permission
 * failure is worded here exactly as it is everywhere else and this file holds no second
 * opinion about what an error code means (A7).
 */
export function AllocationRefusal({
  error,
  drafts,
  documents,
  available,
  onReduceToOutstanding,
  onDismiss,
}: AllocationRefusalProps): ReactElement {
  const token = preconditionToken(error);

  if (token === DOCUMENT_OVER_ALLOCATED) {
    const offenders = overAllocatedDrafts(drafts, documents);

    return (
      <RefusalPanel
        title="One document was asked to settle more than it owes"
        message={
          'Allocations against one document may not exceed it — that would be a claim it was ' +
          'settled twice. Over-paying is not the same thing and is allowed: apply what each ' +
          'document owes and the rest stays as credit on the contact.'
        }
        actions={
          <>
            {offenders.length > 0 && (
              <Button variant="primary" onClick={onReduceToOutstanding}>
                Reduce to what is outstanding
              </Button>
            )}
            <Button onClick={onDismiss}>Leave it as I typed it</Button>
          </>
        }
      >
        {offenders.length > 0 && (
          <ul className="flex flex-col gap-1" aria-label="Documents asked for too much">
            {offenders.map(({ document, asked }) => (
              <li key={document.id} className="text-sm text-text-muted">
                <span className="font-mono text-text">{document.number}</span> has{' '}
                <Amount value={document.outstanding} /> outstanding and was asked for{' '}
                <Amount value={asked} />.
              </li>
            ))}
          </ul>
        )}
      </RefusalPanel>
    );
  }

  if (token === SOURCE_OVER_ALLOCATED) {
    return (
      <RefusalPanel
        title="This payment has less left than the batch asks for"
        message={
          'A payment can settle only what it was for; applying more would clear a balance the ' +
          'ledger never received. Recording more money, or a further credit note, is what makes ' +
          'more available.'
        }
        actions={<Button onClick={onDismiss}>Back to the amounts</Button>}
      >
        <p className="text-sm text-text-muted">
          Left to apply: <Amount value={available} />.
        </p>
      </RefusalPanel>
    );
  }

  return (
    <ErrorBanner
      error={error}
      onRetry={() => {
        onDismiss();
      }}
    />
  );
}

function RefusalPanel({
  title,
  message,
  children,
  actions,
}: {
  readonly title: string;
  readonly message: string;
  readonly children?: ReactElement | false;
  readonly actions: ReactElement;
}): ReactElement {
  return (
    <div
      role="alert"
      className="flex flex-col gap-2 rounded-lg border border-danger-border bg-danger-soft p-3"
    >
      <p className="text-sm font-semibold text-danger-text">{title}</p>
      <p className="text-sm text-text-muted">{message}</p>
      {children}
      <div className="flex flex-wrap gap-2 pt-1">{actions}</div>
    </div>
  );
}
