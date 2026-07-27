import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

/**
 * The vocabulary the B1 narrative is written in.
 *
 * Everything here is either an interaction the DOM makes awkward (the hand-built combobox,
 * the date controls in the report toolbar) or a fact about *when* the books are being kept.
 * Nothing here asserts anything about accounting — those assertions belong in the narrative,
 * where a reader can see the figures next to the entries that produced them.
 */

export interface Registration {
  readonly displayName: string;
  readonly email: string;
  readonly password: string;
  readonly orgName: string;
}

/**
 * A fresh user and a fresh organization, every run.
 *
 * The alternative — a fixed login, truncated between runs — needs a reset step that either
 * deletes from tables the app user holds no `DELETE` on (A6, and it does not) or runs as
 * root, which spec §11 rejects for the same reason it rejects mocks. Registering instead
 * costs one extra screen and makes the suite correct against an empty database, against a
 * developer's working database, and against itself run twice in a row.
 */
export function newRegistration(): Registration {
  const suffix = randomUUID().slice(0, 8);
  return {
    displayName: 'Dana Okonkwo',
    email: `b1-${suffix}@openbooks.test`,
    // Twelve code points is the floor in `auth/password.ts`; this is well clear of it.
    password: 'correct-horse-battery-staple',
    orgName: `Northwind Supply ${suffix}`,
  };
}

/**
 * The month the books are kept in: the current one.
 *
 * Current rather than a fixed date, and rather than the previous month, because the org's
 * fiscal year is generated for the *current* fiscal year and only the current month is
 * guaranteed to fall inside it whatever today is — the previous month belongs to the
 * previous fiscal year for anyone running this on the first day of one (D-17: the start
 * month is a per-org setting and is frequently not January).
 */
export interface MonthUnderTest {
  /** `"July 2026"` — the `fiscal_periods.name` the period screen renders. */
  readonly periodName: string;
  readonly firstDay: string;
  readonly lastDay: string;
  day(dayOfMonth: number): string;
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export function currentMonth(now: Date = new Date()): MonthUnderTest {
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  // Day 0 of the next month is the last day of this one, leap years included.
  const lastDayOfMonth = new Date(year, month, 0).getDate();
  const iso = (dayOfMonth: number): string =>
    `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(dayOfMonth).padStart(2, '0')}`;

  return {
    periodName: `${MONTH_NAMES[month - 1] ?? ''} ${String(year)}`,
    firstDay: iso(1),
    lastDay: iso(lastDayOfMonth),
    day: iso,
  };
}

/**
 * Choose an option in the hand-built combobox (`src/components/combobox.tsx`).
 *
 * Typing rather than scrolling, because that is what the control is for and because the
 * starter chart has sixty-six accounts. `query` is narrowed to a single match on purpose —
 * an account code, a contact's name — and the count is asserted before the click, so a
 * query that quietly matched two options fails here rather than by posting to the wrong
 * account and disagreeing with a figure four screens later.
 */
export async function chooseInCombobox(page: Page, name: string, query: string): Promise<void> {
  const input = page.getByRole('combobox', { name });
  await input.click();
  await input.fill(query);

  const options = page.getByRole('listbox').getByRole('option');
  await expect(options).toHaveCount(1);
  await options.first().click();

  // The input renders the committed option's label, so this both waits for the popover to
  // settle and proves the value was taken rather than merely highlighted (Tab commits
  // nothing, by design).
  await expect(input).not.toHaveValue(query);
}

/**
 * A date control in the report toolbar (`reports/controls.tsx`).
 *
 * Those inputs sit inside a wrapping `<label>` that also carries the hint sentence, so the
 * accessible name is the label *and* the hint — "To Empty includes every posting to date."
 * Anchored at the start rather than matched exactly, which is the difference between a
 * locator and a transcription of the help text.
 */
export function reportDate(page: Page, label: 'From' | 'To' | 'As at'): Locator {
  return page.getByLabel(new RegExp(`^${label}`));
}

/**
 * A total or footing row, found by its row header.
 *
 * The row rather than the cell, because the four reports do not agree on where in the row
 * the figure sits — a statement section's total is followed by an empty Subtotal cell, the
 * trial balance's difference is *preceded* by two empty ones, and a general-ledger balances
 * row carries debits, credits and balance. A helper that guessed would read an empty cell
 * on three of them, and an empty cell compared against an expected amount fails loudly —
 * but the same guess reading the *wrong* amount would not.
 */
export function rowIn(table: Locator, rowHeader: RegExp): Locator {
  return table
    .getByRole('row')
    .filter({ has: table.page().getByRole('rowheader', { name: rowHeader }) });
}
