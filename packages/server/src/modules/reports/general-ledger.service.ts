import type {
  GeneralLedger,
  GeneralLedgerEntry,
  GeneralLedgerQueryInput,
  GeneralLedgerQueryParams,
} from '@openbooks/shared-types';
import { generalLedgerQuerySchema, GL_COUNTERPARTY_ACCOUNTS_MAX } from '@openbooks/shared-types';

import { getContext } from '../../context';
import type { RequestContext } from '../../context';
import type { TenantDatabase } from '../../db';
import { bufferToUuid, resolvePageLimit } from '../../db';
import { InternalError, parseInput } from '../../errors';
import { requirePermission } from '../permissions';

import type { AccountBalance, BalanceAmounts } from './amounts';
import {
  orgScope,
  resolveContact,
  resolveDimension,
  resolveDimensionValues,
} from './balances.repository';
import type { ResolvedDimensionFilter } from './balances.repository';
import { getAccountBalances } from './balances.service';
import type {
  CounterpartyLineRow,
  GeneralLedgerAccount,
  GeneralLedgerLineRow,
  GeneralLedgerSpec,
  LineTagRow,
  MovementTotals,
} from './general-ledger.repository';
import {
  resolveLedgerAccount,
  selectCounterpartyLines,
  selectGeneralLedgerLines,
  selectLineTags,
  selectMovementBefore,
} from './general-ledger.repository';

/**
 * The general ledger (OB-044; spec §2.6, acceptance B4 and B6; D-13, D-14, D-21).
 *
 * One account over a range: what it was carrying, the lines that moved it, and
 * what it ended on. It is two reads and they are not the same query.
 *
 *  - **The three balances come from the report core.** `getAccountBalances` is
 *    where opening, movement and closing are decomposed, and B4 is true there by
 *    construction — `closing` is the sum of the other two rather than a third
 *    aggregate. A second aggregation here would be a second place for the boundary
 *    between "before the range" and "in the range" to be described, which is the
 *    one thing OB-041's commentary is most insistent about.
 *  - **The entries are a keyset-paged list**, which the core cannot express at all.
 *
 * ## The running balance, and what paging does to it
 *
 * A running balance is cumulative, so the first row of page two depends on every
 * row before it, none of which page two fetched. Three ways to answer that:
 *
 *  1. Carry the balance in the cursor.
 *  2. Recompute, per page, the movement that precedes it.
 *  3. Refuse to page, and return the whole range.
 *
 * This is (2), and the choice is about which lie a client is told when the ledger
 * changes underneath a read — because in this system it will. A journal's
 * `entry_date` is chosen by the user, so a correction posted this afternoon for
 * last month lands *behind* a cursor that has already passed last month. That is
 * not a hypothetical; it is the ordinary way a mistake is fixed here (D-02: there
 * is no edit, only a reversing entry), and D-21 chose keyset over offset for
 * exactly this event.
 *
 * Under (1), the carried number is a snapshot of a ledger that no longer exists.
 * Every subsequent page's running balance is arithmetically consistent with the
 * page before it, and the final row silently disagrees with `closing` by the
 * amount of the back-dated entry — a discrepancy at the *bottom* of the report,
 * with nothing on the page to explain it, and a client that trusted the totals
 * would have to reconcile two numbers this API gave it in the same response. It
 * also puts a client-supplied number into the arithmetic, which is a cursor that
 * is no longer merely a position.
 *
 * Under (2), the back-dated entry is still never shown — it is behind the cursor,
 * and nothing can put it in front of one — but it *is* counted, from the page it
 * lands before onward. The visible effect is a step in the running balance at one
 * page boundary, exactly the size of the entry that arrived, and `closing` on that
 * page differs from `closing` on the page before it. Both are visible, both are
 * where the change actually happened, and the last row's running balance still
 * equals the last page's `closing`. Each page is a true statement about the ledger
 * at the moment it was read, and two pages disagreeing is the honest report that
 * the ledger moved between them — which is why the three balances ride on every
 * page rather than only the first.
 *
 * (3) was not seriously available: a general ledger for a year on a busy bank
 * account is tens of thousands of lines, and an unbounded response is a request
 * whose cost is set by the caller's data (`pagination.ts`).
 *
 * The recomputation is one aggregate per page, over the same builder the page
 * itself is drawn from, bounded by the first row the page returned — see
 * `selectMovementBefore`. It costs a second round trip per page and it means this
 * file never decodes a cursor, so there remains exactly one cursor format in the
 * system and `keyset.ts` owns it.
 *
 * ## What is not attempted
 *
 * No snapshot isolation across pages. Holding a transaction open between two HTTP
 * requests is not a thing a stateless API can do, and a "read the ledger as at
 * instant T" ledger would need a temporal query the schema does not support —
 * `journals.created_at` is an instant, but `journal_lines` inherits nothing that
 * makes "as the ledger stood then" expressible under the range filters. Reporting
 * the movement instead of hiding it is the answer this ticket can actually keep.
 */

export type GeneralLedgerQuery = GeneralLedgerQueryInput;

/**
 * `reports.read`, matching the core.
 *
 * Not `journals.read` in addition, even though this returns individual journal
 * lines. The argument is the core's own: a role that can read a report but not
 * drill into the figures it prints is not a distinction any of the six seeded
 * roles draws, and a drill-down that 403s from the report that offered it is a
 * dead end rather than a control.
 */
export async function getGeneralLedger(
  query: GeneralLedgerQuery,
  ctx: RequestContext = getContext('getGeneralLedger()'),
): Promise<GeneralLedger> {
  await requirePermission(ctx, 'reports.read');
  const request = parseInput(generalLedgerQuerySchema, query);
  const limit = resolvePageLimit(request.limit);

  const db = orgScope(ctx);
  const account = await resolveLedgerAccount(db, request.accountId);
  const spec = await resolveSpec(db, account, request);

  const balance = await coreBalance(account, request, ctx);
  const page = await selectGeneralLedgerLines(db, spec, limit, request.cursor);

  const first = page.rows[0];
  const inherited: MovementTotals =
    first === undefined ? { debits: 0n, credits: 0n } : await selectMovementBefore(db, spec, first);

  const [counterparties, tags] = await Promise.all([
    selectCounterpartyLines(db, distinctJournalIds(page.rows)),
    selectLineTags(
      db,
      page.rows.map((row) => row.line_id),
    ),
  ]);

  return {
    accountId: account.accountId,
    code: account.code,
    name: account.name,
    type: account.type,
    normalBalance: account.normalBalance,
    from: spec.from,
    to: spec.to,
    opening: toWireAmounts(balance.opening),
    movement: toWireAmounts(balance.movement),
    closing: toWireAmounts(balance.closing),
    entries: toEntries(page.rows, {
      // The balance this page starts from: everything before the range, plus the
      // part of the range that sorts ahead of this page's first row.
      running: balance.opening.balance + inherited.debits - inherited.credits,
      counterparties: indexCounterparties(counterparties),
      tags: indexTags(tags),
    }),
    nextCursor: page.nextCursor,
  };
}

/**
 * The account's decomposition, from the core.
 *
 * One account, through the core's `accountIds` option. This used to narrow by
 * `types` instead — the widest filter the core's wire query offers — and so
 * aggregated every account of one type in order to read a single row. That was
 * harmless arithmetic and the wrong shape, and the option exists now precisely so
 * this call asks for what it wants.
 *
 * The filters are passed through as the caller sent them rather than as the bytes
 * already resolved for `spec`, because the core resolves its own. That is a second
 * point read per filter, and it is worth it: the alternative is a spec built by
 * hand and handed to a repository past the parse, which is the wiring fault
 * `dimensionFilterPredicate` throws `InternalError` about.
 */
async function coreBalance(
  account: GeneralLedgerAccount,
  request: GeneralLedgerQueryParams,
  ctx: RequestContext,
): Promise<AccountBalance> {
  const balances = await getAccountBalances(
    {
      ...(request.from === undefined ? {} : { from: request.from }),
      ...(request.to === undefined ? {} : { to: request.to }),
      ...(request.contactId === undefined ? {} : { contactId: request.contactId }),
      ...(request.dimensions === undefined ? {} : { dimensions: request.dimensions }),
    },
    ctx,
    { accountIds: [account.accountId] },
  );

  const group = balances.groups[0];
  const row = group?.rows.find((candidate) => candidate.accountId === account.accountId);
  if (row === undefined) {
    // The core is dense — every account it was asked about carries a row in every
    // group, at zero where the ledger had nothing — and this account was read out
    // of `accounts` a moment ago. An absent row means the two disagree about the
    // chart, which is not a condition a caller can cause.
    throw new InternalError(
      'The report core returned no row for an account that exists, so the ledger has no ' +
        'opening balance to run from.',
    );
  }

  return row.balance;
}

async function resolveSpec(
  db: TenantDatabase,
  account: GeneralLedgerAccount,
  request: GeneralLedgerQueryParams,
): Promise<GeneralLedgerSpec> {
  const dimensions: ResolvedDimensionFilter[] = [];
  for (const filter of request.dimensions ?? []) {
    const dimensionId = await resolveDimension(db, filter.dimensionId);
    dimensions.push({
      dimensionId,
      valueIds: await resolveDimensionValues(db, dimensionId, filter.valueIds ?? []),
      includeUnassigned: filter.includeUnassigned ?? false,
    });
  }

  return {
    accountId: account.id,
    from: request.from ?? null,
    to: request.to ?? null,
    contactId: request.contactId === undefined ? null : await resolveContact(db, request.contactId),
    dimensions,
  };
}

interface EntryAssembly {
  /** The balance entering this page: opening plus the range's movement ahead of it. */
  readonly running: bigint;
  readonly counterparties: ReadonlyMap<string, JournalSides>;
  readonly tags: ReadonlyMap<bigint, GeneralLedgerEntry['tags']>;
}

function toEntries(
  rows: readonly GeneralLedgerLineRow[],
  into: EntryAssembly,
): GeneralLedgerEntry[] {
  let running = into.running;

  return rows.map((row) => {
    running += row.debit_minor - row.credit_minor;

    return {
      lineId: row.line_id.toString(),
      journalId: bufferToUuid(row.journal_id),
      sequenceNumber: row.sequence_number.toString(),
      lineNumber: row.line_number,
      date: row.entry_date,
      journalMemo: row.journal_memo,
      lineMemo: row.line_memo,
      contact:
        row.contact_id === null
          ? null
          : {
              contactId: bufferToUuid(row.contact_id),
              // `fk_journal_lines_contact` is RESTRICT, so a line naming a contact
              // has a `contacts` row; the LEFT JOIN cannot leave this NULL while
              // `contact_id` is set.
              displayName: row.contact_name ?? '',
            },
      debit: row.debit_minor.toString(),
      credit: row.credit_minor.toString(),
      runningBalance: running.toString(),
      counterparty: counterpartyOf(row, into.counterparties),
      tags: into.tags.get(row.line_id) ?? [],
    };
  });
}

interface AccountRef {
  readonly accountId: string;
  readonly code: string;
  readonly name: string;
}

interface JournalSides {
  readonly debits: ReadonlyMap<string, AccountRef>;
  readonly credits: ReadonlyMap<string, AccountRef>;
}

/**
 * The accounts on the opposite side of this line's journal.
 *
 * The opposite *side*, not the other lines — `general-ledger.ts` in shared-types
 * carries the argument, and it is the decision that makes a split entry readable:
 * on a rent journal debiting three departments against one bank credit, the other
 * two departments explain nothing about the first.
 */
function counterpartyOf(
  row: GeneralLedgerLineRow,
  index: ReadonlyMap<string, JournalSides>,
): GeneralLedgerEntry['counterparty'] {
  const sides = index.get(row.journal_id.toString('hex'));
  if (sides === undefined) return { accounts: [], accountCount: 0 };

  const opposite = row.debit_minor > 0n ? sides.credits : sides.debits;
  const accounts = [...opposite.values()].sort((left, right) =>
    left.code < right.code ? -1 : left.code > right.code ? 1 : 0,
  );

  return {
    accounts: accounts.slice(0, GL_COUNTERPARTY_ACCOUNTS_MAX),
    accountCount: accounts.length,
  };
}

function distinctJournalIds(rows: readonly GeneralLedgerLineRow[]): readonly Buffer[] {
  const seen = new Map<string, Buffer>();
  for (const row of rows) seen.set(row.journal_id.toString('hex'), row.journal_id);
  return [...seen.values()];
}

function indexCounterparties(
  rows: readonly CounterpartyLineRow[],
): ReadonlyMap<string, JournalSides> {
  const index = new Map<
    string,
    { debits: Map<string, AccountRef>; credits: Map<string, AccountRef> }
  >();

  for (const row of rows) {
    const key = row.journal_id.toString('hex');
    const sides = index.get(key) ?? { debits: new Map(), credits: new Map() };
    index.set(key, sides);

    const side = row.is_debit ? sides.debits : sides.credits;
    side.set(row.account_id.toString('hex'), {
      accountId: bufferToUuid(row.account_id),
      code: row.code,
      name: row.name,
    });
  }

  return index;
}

/**
 * Tags per line, in dimension-code then value-code order.
 *
 * Sorted here rather than in SQL because the rows arrive for a whole page at once
 * and are then split by line; an `ORDER BY` would order the page's rows and leave
 * each line's slice ordered only by accident of which lines interleave.
 */
function indexTags(rows: readonly LineTagRow[]): ReadonlyMap<bigint, GeneralLedgerEntry['tags']> {
  const index = new Map<bigint, GeneralLedgerEntry['tags']>();

  for (const row of rows) {
    const tags = index.get(row.journal_line_id) ?? [];
    index.set(row.journal_line_id, tags);
    tags.push({
      dimensionId: bufferToUuid(row.dimension_id),
      dimensionCode: row.dimension_code,
      dimensionValueId: bufferToUuid(row.dimension_value_id),
      code: row.code,
      name: row.name,
    });
  }

  for (const tags of index.values()) {
    tags.sort((left, right) => {
      const axis = compareText(left.dimensionCode, right.dimensionCode);
      return axis === 0 ? compareText(left.code, right.code) : axis;
    });
  }

  return index;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** D-13's single conversion out: `bigint` minor units become cents-only strings here. */
function toWireAmounts(amounts: BalanceAmounts): {
  readonly debits: string;
  readonly credits: string;
  readonly balance: string;
} {
  return {
    debits: amounts.debits.toString(),
    credits: amounts.credits.toString(),
    balance: amounts.balance.toString(),
  };
}
