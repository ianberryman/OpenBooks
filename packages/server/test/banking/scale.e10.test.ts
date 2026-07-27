import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CreateBankStatementImportRequest } from '@openbooks/shared-types';

import { InProcessQueue, setQueueProvider } from '../../src/providers';
import { proposeMatches } from '../../src/modules/banking/matching/service';
import {
  registerStatementImportJob,
  startImport,
} from '../../src/modules/banking/statements/service';

import { bufferToUuid } from '../db';
import {
  fakeParse,
  fileContent,
  importOf,
  linesOf,
  sceneIn,
  silentLogger,
  useServiceDatabase,
  withContext,
  type FileRow,
  type Scene,
} from './support';

/**
 * E10, measured rather than asserted (OB-088, wave 5; ROADMAP E1, E10, D-42, D-47).
 *
 * > A 5,000-line statement imports and matches without pathological behaviour.
 *
 * "Pathological" has a precise, measurable meaning here, and this file measures each
 * part rather than trusting it:
 *
 *  1. **The import completes in a sane bound.** A 5,000-line file goes through the real
 *     dedupe, the real queue, and the real INSERT — only the format reading is faked
 *     (OB-076/OB-077 own that) — and the elapsed time is reported, not just bounded.
 *  2. **A page of proposals issues a bounded number of queries — not O(lines).** The
 *     match engine loads every source once for the page (`matching/service.ts`), so the
 *     query count for a 200-line page and a 50-line page must be the *same* constant,
 *     and both far below the 5,000 lines in the account. Proven by the delta in MySQL's
 *     global `Questions` counter across the call, which is exact under this suite's
 *     serial execution (`fileParallelism: false`).
 *  3. **Re-import collapses to zero new (E1 at scale).** The same 5,000 lines imported a
 *     second time create no row — the D-42 occurrence-index dedupe, at scale.
 *
 * The numbers this file prints are the deliverable: Ian values a measured result over a
 * plausible one (CLAUDE.md). The asserted bounds are deliberately loose — an order of
 * magnitude of headroom — because the property is *shape* (constant, not linear), and a
 * tight wall-clock bound would make the suite a flaky benchmark of the CI host.
 */

const db = useServiceDatabase();
const LINES = 5_000;

let scene: Scene;
beforeEach(async () => {
  scene = await sceneIn(db);
});
afterEach(() => {
  setQueueProvider(undefined);
});

/**
 * A 5,000-line statement, every line distinct: a distinct description, reference and
 * amount, so every fingerprint is unique and the whole file is genuinely new lines on
 * the first import. Dates spread across a month so the match engine's per-page date
 * window is a real cut rather than the whole file, and the sign alternates so a page
 * draws both the invoice and the bill sources.
 */
function bigStatement(): FileRow[] {
  const rows: FileRow[] = [];
  for (let i = 0; i < LINES; i += 1) {
    const day = String((i % 28) + 1).padStart(2, '0');
    rows.push({
      postedDate: `2026-01-${day}`,
      amount: (i % 2 === 0 ? 1n : -1n) * BigInt(10_000 + i),
      description: `TXN ${String(i).padStart(5, '0')}`,
      counterparty: `Payee ${String(i % 200)}`,
      bankReference: `REF${String(i).padStart(6, '0')}`,
    });
  }
  return rows;
}

/**
 * A deterministic shuffle — a fixed-seed LCG, so the re-import's ordering is genuinely
 * different from the first import's yet reproducible across runs. E1 is "no duplicates
 * whatever the file's ordering" (D-42), so the re-import must arrive shuffled: an
 * identical re-upload is robust even against a dedupe that numbered by file position,
 * because the `(fingerprint, occurrence_index)` key is byte-stable; a shuffle is what
 * makes a position-based mutation produce duplicates, and this is where it is caught.
 */
function shuffled<T>(items: readonly T[]): T[] {
  const out = [...items];
  let seed = 0x9e3779b1;
  for (let i = out.length - 1; i > 0; i -= 1) {
    seed = (seed * 1_103_515_245 + 12_345) & 0x7fff_ffff;
    const j = seed % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function requestFor(content: string): CreateBankStatementImportRequest {
  return {
    bankAccountId: scene.bankAccountUuid,
    format: 'ofx',
    filename: 'big.ofx',
    content,
  };
}

async function importToCompletion(queue: InProcessQueue, content: string): Promise<string> {
  const started = await withContext(scene.ctx, () => startImport(requestFor(content), scene.ctx));
  await queue.settled();
  return started.id;
}

/** MySQL's global count of statements executed — the query counter, read off-band. */
async function questions(): Promise<number> {
  const { rows } = await sql<{ Variable_name: string; Value: string }>`
    SHOW GLOBAL STATUS LIKE 'Questions'
  `.execute(db.migrator);
  return Number(rows[0]?.Value ?? '0');
}

/** Runs `body` and returns the DB statements it issued (global `Questions` delta). */
async function countingQueries<T>(body: () => Promise<T>): Promise<{ result: T; queries: number }> {
  const before = await questions();
  const result = await body();
  const after = await questions();
  // The trailing `questions()` read is one statement inside the window; subtract it so
  // the figure is the queries `body` issued, not the measurement's own overhead.
  return { result, queries: after - before - 1 };
}

/** An evaluator that matches nothing — the rules source is OB-080's, batched by design. */
const noRuleDeps = { ruleEvaluator: { evaluate: () => Promise.resolve(new Map<string, never>()) } };

describe('E10: a 5,000-line statement imports and matches without pathological behaviour', () => {
  it('imports 5,000 lines, pages proposals in O(1) queries, and re-imports to zero new', async () => {
    const queue = new InProcessQueue(silentLogger);
    setQueueProvider(queue);
    await registerStatementImportJob(queue, { parse: fakeParse, logger: silentLogger });

    const rows = bigStatement();
    const content = fileContent(rows, { closingBalance: 0n });

    // --- 1. Import, timed. -------------------------------------------------------
    const importStart = performance.now();
    const firstId = await importToCompletion(queue, content);
    const importMs = Math.round(performance.now() - importStart);

    expect(await importOf(db.app, firstId)).toMatchObject({
      status: 'complete',
      lines_read: LINES,
      lines_duplicate: 0,
    });
    expect(await linesOf(db.app, scene.bankAccountId)).toHaveLength(LINES);

    // --- 2. A page of proposals: query count, independent of page size. ----------
    // The engine loads the open-invoice source only if the page has an inbound line and
    // the open-bill source only if it has an outbound one, so a fair size comparison
    // must hold the *sign mix* constant — both pages carry both signs. Then any
    // difference in the query count is page size alone, which is exactly what must be
    // zero.
    const stored = await db.app
      .selectFrom('bank_statement_lines')
      .select(['id', 'amount_minor'])
      .where('bank_account_id', '=', scene.bankAccountId)
      .execute();
    const inbound = stored
      .filter((row) => row.amount_minor > 0n)
      .map((row) => bufferToUuid(row.id));
    const outbound = stored
      .filter((row) => row.amount_minor < 0n)
      .map((row) => bufferToUuid(row.id));

    const balancedPage = (half: number): string[] => [
      ...inbound.slice(0, half),
      ...outbound.slice(0, half),
    ];
    const page200 = balancedPage(100); // 100 in + 100 out
    const page50 = balancedPage(25); //  25 in +  25 out

    // Warm the pool and the query plans once, so the measurement is steady state rather
    // than first-call connection setup.
    await withContext(scene.ctx, () => proposeMatches({ lineIds: page50 }, noRuleDeps, scene.ctx));

    const big = await countingQueries(() =>
      withContext(scene.ctx, () => proposeMatches({ lineIds: page200 }, noRuleDeps, scene.ctx)),
    );
    const small = await countingQueries(() =>
      withContext(scene.ctx, () => proposeMatches({ lineIds: page50 }, noRuleDeps, scene.ctx)),
    );

    expect(big.result.lines).toHaveLength(200);
    expect(small.result.lines).toHaveLength(50);

    // The whole point of E10: proposing for 4× as many lines is the *same* number of
    // queries — the engine loads each source once per page (`matching/service.ts`), so
    // the count does not scale with the page, and certainly not with the 5,000 lines in
    // the account. If it were O(lines) the 200-line page would cost ~150 more than the
    // 50-line one.
    expect(big.queries).toBe(small.queries);
    expect(big.queries).toBeLessThan(30);
    expect(big.queries).toBeLessThan(LINES / 10);

    // --- 3. Re-import the same lines, shuffled: nothing new (E1 at scale). --------
    const reimportStart = performance.now();
    const secondId = await importToCompletion(queue, fileContent(shuffled(rows)));
    const reimportMs = Math.round(performance.now() - reimportStart);

    expect(await importOf(db.app, secondId)).toMatchObject({
      status: 'complete',
      lines_read: LINES,
      lines_duplicate: LINES,
    });
    expect(await linesOf(db.app, scene.bankAccountId)).toHaveLength(LINES);

    // The measured result — printed so the numbers are the record, not the assertion.
    console.log(
      `[E10] import ${LINES} lines: ${importMs}ms | re-import (all duplicate): ${reimportMs}ms | ` +
        `proposals/page queries: 50-line=${small.queries} 200-line=${big.queries}`,
    );

    // A sane bound with an order of magnitude of headroom — a regression to per-line
    // work would blow through this, a slow CI host will not.
    expect(importMs).toBeLessThan(20_000);
  }, 180_000);
});
