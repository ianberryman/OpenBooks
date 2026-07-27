import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';

/**
 * The banking vocabulary the M4 narrative is written in (OB-090; ROADMAP D-26, D-46).
 *
 * Two kinds of thing live here, and both are *setup that is not the point of the narrative*
 * — the same reason `support/books.ts` keeps the combobox and the calendar out of the story.
 * The narrative's own claims are the figures it reads off the banking screens; everything in
 * this file is the ledger those screens sit on top of, put in place the shortest honest way.
 *
 * ## Why the bank account is seeded over the API, not clicked
 *
 * There is deliberately **no bank-account-creation screen** in M4. The three banking screens
 * each pick an *existing* account from `GET /v1/bank-accounts`; registering one is
 * `POST /v1/bank-accounts`, an API-only route (`bank-accounts.ts` — "setting up the account a
 * statement imports into is the import surface's own concern", and no UI was built for it).
 * So a browser narrative has no way to create the account it then imports into, and must seed
 * it. That is a real product gap, flagged in the ticket report, not a shortcut taken here.
 *
 * ## Why two journals are posted over the API
 *
 * The narrative needs a ledger that already holds things a statement will reconcile against:
 * an entry the bank's deposit *matches* (so the match screen has a proposal to accept, E3),
 * and an unpresented cheque the bank has *not* caught up with (so reconciliation has a
 * reconciling difference to explain that does not block finalising, D-50). Posting a journal
 * in a browser is what `month-of-books.spec.ts` already proves end to end; re-proving it here
 * would be a second narrative wearing the first's clothes (D-26). So these two are seeded, and
 * the browser is spent on import → match → reconcile, which nothing else covers.
 *
 * Every request rides the session cookie the UI registration set, through the same dev proxy
 * the app uses — `page.request` shares the page's cookie jar and `baseURL` — so this is the
 * real Fastify app under the real two-user grant split, reached exactly as the browser reaches
 * it. No credential is handled here and nothing is stubbed.
 */

/** `Idempotency-Key`, lower-cased as `openapi.json` names it — required on every write. */
const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

function writeHeaders(): Record<string, string> {
  // A fresh key per seeding call: each is one intent, issued once, and never retried by hand.
  return { [IDEMPOTENCY_KEY_HEADER]: randomUUID() };
}

interface AccountSummary {
  readonly id: string;
  readonly code: string | null;
  readonly name: string;
}

interface AccountPage {
  readonly items: readonly AccountSummary[];
  readonly nextCursor: string | null;
}

/**
 * The org's chart as a `code → id` map, followed to the last page.
 *
 * A map rather than a lookup-per-call, because the narrative names four accounts (the bank
 * ledger account and the three the entries touch) and the starter chart is sixty-six: one
 * read, then constant-time resolution. `code` is what a human knows an account by; the API
 * speaks `id`, so this is the one translation the seeding needs.
 */
export async function chartByCode(request: APIRequestContext): Promise<Map<string, string>> {
  const byCode = new Map<string, string>();
  let cursor: string | undefined;
  for (;;) {
    const query = new URLSearchParams({ isActive: 'true', limit: '200' });
    if (cursor !== undefined) query.set('cursor', cursor);
    const response = await request.get(`/v1/accounts?${query.toString()}`);
    expect(response.ok(), `GET /v1/accounts → ${String(response.status())}`).toBeTruthy();
    const page = (await response.json()) as AccountPage;
    for (const account of page.items) {
      if (account.code !== null) byCode.set(account.code, account.id);
    }
    if (page.nextCursor === null) return byCode;
    cursor = page.nextCursor;
  }
}

export interface SeedBankAccount {
  readonly accountId: string;
  readonly name: string;
  readonly institutionName: string;
  readonly externalAccountId: string;
}

interface BankAccountResponse {
  readonly id: string;
  readonly name: string;
}

/**
 * Registers an existing ledger account as a bank account, and returns what the pickers show.
 *
 * The 201 body carries the `name` the three screens' comboboxes list it under, so the
 * narrative selects by exactly that string rather than by an id it would otherwise have to
 * carry around.
 */
export async function seedBankAccount(
  request: APIRequestContext,
  input: SeedBankAccount,
): Promise<BankAccountResponse> {
  const response = await request.post('/v1/bank-accounts', {
    headers: writeHeaders(),
    data: input,
  });
  expect(response.ok(), `POST /v1/bank-accounts → ${String(response.status())}`).toBeTruthy();
  return (await response.json()) as BankAccountResponse;
}

export interface SeedJournalLine {
  readonly accountId: string;
  readonly side: 'debit' | 'credit';
  /** Minor units, as a positive cents-only string — `"150000"` is 1500.00 (D-13). */
  readonly amount: string;
}

export interface SeedJournal {
  readonly date: string;
  readonly memo: string;
  readonly lines: readonly SeedJournalLine[];
}

/**
 * Posts one manual journal straight to the ledger.
 *
 * The entry date must fall in an open fiscal period — periods are never created as a side
 * effect of posting (D-17) — so the narrative generates the year in the browser before this
 * is ever called.
 */
export async function postJournal(request: APIRequestContext, journal: SeedJournal): Promise<void> {
  const response = await request.post('/v1/journals', {
    headers: writeHeaders(),
    data: journal,
  });
  expect(response.ok(), `POST /v1/journals → ${String(response.status())}`).toBeTruthy();
}

/**
 * A CSV statement, built from rows so the narrative reads as the figures it asserts.
 *
 * ISO dates and a single signed amount column, which is the mapping editor's default date
 * order (`ymd`) and amount convention (`signed`) — so the narrative assigns the three
 * required columns and leaves the rest, rather than driving every control to prove the
 * defaults it does not depend on.
 */
export interface StatementRow {
  readonly date: string;
  readonly description: string;
  /** A signed decimal as a bank writes it — `"1500.00"` in, `"-400.00"` out. */
  readonly amount: string;
}

export function csvStatement(rows: readonly StatementRow[]): string {
  const lines = ['Date,Description,Amount'];
  for (const row of rows) lines.push(`${row.date},${row.description},${row.amount}`);
  // A trailing newline, as a real export has; the parser ignores the empty final line.
  return `${lines.join('\n')}\n`;
}

/**
 * Choose an option in a Radix `Select` (`components/select.tsx`) — the closed, short lists the
 * mapping editor is built from.
 *
 * Distinct from `chooseInCombobox`: a `Select` has no text entry, so this opens the trigger
 * and clicks the option rather than typing to filter. The trigger carries `role="combobox"`
 * (Radix's own), named by its `Field` label; `exact` on both the trigger and the option
 * because the editor sits an "Amount" column select next to an "Amount columns" convention
 * select, and a substring name would not tell them apart.
 */
export async function chooseSelectOption(
  page: Page,
  triggerName: string,
  optionLabel: string,
): Promise<void> {
  await page.getByRole('combobox', { name: triggerName, exact: true }).click();
  await page.getByRole('option', { name: optionLabel, exact: true }).click();
}
