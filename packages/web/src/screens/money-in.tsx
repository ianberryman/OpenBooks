import type { ReactElement } from 'react';
import { useState } from 'react';

import { AgingView } from './money-in/aging';
import { ViewSwitch } from './money-in/controls';
import { PaymentsView } from './money-in/payments';

/**
 * Money in and money out (OB-070; ROADMAP D-13, D-21, D-34, D-37, D-39, D-40).
 *
 * Recording payments in both directions, applying them, un-applying them, voiding them —
 * and the aging report the same rows are aggregated into.
 *
 * ## D-37 is the decision this screen exists to make legible
 *
 * **A payment is an amount of money that moved. An allocation is a separate fact about
 * what it settles.** Nothing requires the two to be equal, and an unallocated remainder is
 * a credit balance on the contact, applicable later.
 *
 * Three consequences shape everything below, and each of them is a thing a user can see:
 *
 * 1. **Recording a payment never asks for an invoice.** The picker is optional, closed by
 *    default, below the fields that describe the movement. A deposit arriving before
 *    anyone has decided what it settles is the common case, not an incomplete entry.
 * 2. **The remainder is presented as an asset the user can spend.** "On account" is a
 *    column in the list and the first thing on the detail panel, in the accent role rather
 *    than the warning one. A screen that nagged about it would teach people to invent an
 *    allocation, which is precisely the un-auditable move the subledger replaces.
 * 3. **The asymmetry is stated rather than discovered.** Over-allocating a *document* is
 *    refused (C3) and over-*paying* is fine. The allocation form says both, and when the
 *    server refuses, the refusal offers the repair — reduce to what the document owes and
 *    leave the difference as credit.
 *
 * ## What this screen never computes
 *
 * Outstanding, and status. Both are derived on the server from the documents and the
 * allocations, on read, and stored nowhere (D-34, D-38) — so the figure this screen shows
 * is the figure the API returned, and re-deriving one from the allocation rows a panel
 * happens to hold would be the second definition of outstanding that D-34 exists to
 * prevent. Amounts are cents-only strings throughout (D-13); the one place arithmetic
 * happens is `money-in/amounts.tsx`, in `bigint`, and it says why.
 *
 * ## Why aging lives here and not on the reports screen
 *
 * Every report on `/reports` is an aggregation over journal lines. Aging is an aggregation
 * over documents and allocations, which is what makes C8 — the buckets tie to the control
 * account — worth asserting at all. It is also the report the person applying a payment is
 * reading while they do it: the credit this screen creates is a row on that report the
 * moment it exists, and the two being one screen is what makes that visible.
 */

type View = 'payments' | 'aging';

const VIEWS: readonly { readonly id: View; readonly label: string }[] = [
  { id: 'payments', label: 'Payments' },
  { id: 'aging', label: 'Aging' },
];

export function MoneyInScreen(): ReactElement {
  const [view, setView] = useState<View>('payments');

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold text-text">Money</h1>

      <ViewSwitch label="View" value={view} options={VIEWS} onChange={setView} />

      {/**
       * Unmounted rather than hidden, and the two hold their own state.
       *
       * Unlike the reports screen — where one period is one enquiry across four viewers —
       * these two share no controls worth carrying: a payment list is filtered by contact
       * and direction, and an aging report is drawn at a date. What they do share is the
       * cache, so a payment recorded on the first tab invalidates the second's report and
       * the credit is on it when the reader arrives.
       */}
      {view === 'payments' ? <PaymentsView /> : <AgingView />}
    </div>
  );
}
