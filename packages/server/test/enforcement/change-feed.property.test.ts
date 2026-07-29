import type { ChangeFeedEvent } from '@openbooks/shared-types';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { readChangeFeed } from '../../src/modules/change-feed';
import { emitEvent } from '../../src/modules/events';
import type { AppConnection } from '../db';
import { newUuid, useTestDatabase } from '../db';

import {
  markedInvoiceApprovedInput,
  orgIn,
  readEventLog,
  transactionOn,
  type OrgCtx,
} from './event-outbox-support';

/**
 * F8 (OB-107; ROADMAP D-56, D-57; spec §11): **per-org ordering is total, and the
 * change feed replays every event exactly once from any cursor.**
 *
 * The write side — `event_log.position` allocation and its mutation coverage — is
 * `event-outbox.property.test.ts`; this file is the read side:
 * `readChangeFeed`'s keyset over `event_log` (`change-feed.repository.ts`).
 *
 * Every event here is a direct, synthetic `emitEvent` call
 * (`markedInvoiceApprovedInput`) rather than a real invoice approval — F8 is a
 * claim about the outbox's own mechanism, independent of which business event
 * produced a row, and a marker payload is a lot cheaper per event than a real
 * approval when a run needs a dozen of them. `event-outbox.property.test.ts`
 * already proves the mechanism agrees with a real business run; this file spends
 * its run count on ordering and replay instead.
 *
 * Real MySQL, no pool: see `event-outbox-support.ts`'s header for why every call
 * is pinned to one `openAppConnection()` handle rather than the process pool.
 */
const db = useTestDatabase();

interface MarkedEvent {
  readonly marker: string;
  readonly amount: bigint;
}

async function emitMarked(
  connection: AppConnection,
  org: OrgCtx,
  amount: bigint,
): Promise<MarkedEvent> {
  const marker = newUuid();
  await transactionOn(connection, org.ctx, () =>
    emitEvent(markedInvoiceApprovedInput(org.orgUuid, org.ctx, marker, amount), org.ctx),
  ).promise;
  return { marker, amount };
}

function expectPayloadMatches(event: ChangeFeedEvent, expected: MarkedEvent): void {
  // `ChangeFeedEvent.payload` is an opaque index-signature record on the wire; narrow to the
  // two keys this suite's invoice events carry so strict TS allows the reads.
  const payload = event.payload as Record<'invoiceId' | 'total', unknown>;
  expect(payload.invoiceId).toBe(expected.marker);
  // Cents-only string (D-13): the `bigint` this file passed in, stringified by
  // `serializeEventValue` — never a decimal, never a JSON number.
  expect(payload.total).toBe(expected.amount.toString());
}

const amountArb: fc.Arbitrary<bigint> = fc.bigInt({ min: 1n, max: 999_999n });

describe('F8 — per-org position is gapless, increasing, and independent across orgs', () => {
  it('interleaving two orgs produces two independent 1..N sequences, no cross-talk', async () => {
    const connection = await db.openAppConnection();

    try {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.record({ org: fc.constantFrom<0 | 1>(0, 1), amount: amountArb }), {
            minLength: 3,
            maxLength: 14,
          }),
          async (ops) => {
            const orgs = [await orgIn(db), await orgIn(db)] as const;
            const expected: [MarkedEvent[], MarkedEvent[]] = [[], []];

            for (const op of ops) {
              const org = orgs[op.org];
              const marked = await emitMarked(connection, org, op.amount);
              expected[op.org].push(marked);
            }

            for (const index of [0, 1] as const) {
              const rows = await readEventLog(db.app, orgs[index].orgId);
              const list = expected[index];

              // Gapless and strictly increasing from 1 — a stuck or reused counter
              // would fail this directly, before ever reaching the unique index.
              expect(rows.map((row) => row.position.toString())).toEqual(
                list.map((_, position) => String(position + 1)),
              );
              // Each event exactly once, in the order it was emitted — a double-emit
              // would make this list longer than what this org's own ops produced.
              rows.forEach((row, position) => {
                const item = list[position];
                if (item === undefined) throw new Error('More rows than expected events.');
                expect((row.payload as Record<'invoiceId', unknown>).invoiceId).toBe(item.marker);
              });
            }

            // No cross-talk: an org's markers never appear on the other org's log.
            const markersOf = (list: readonly MarkedEvent[]): ReadonlySet<string> =>
              new Set(list.map((item) => item.marker));
            const rowsA = await readEventLog(db.app, orgs[0].orgId);
            const rowsB = await readEventLog(db.app, orgs[1].orgId);
            const inB = markersOf(expected[1]);
            const inA = markersOf(expected[0]);
            const markerOf = (row: (typeof rowsA)[number]): string =>
              (row.payload as Record<'invoiceId', unknown>).invoiceId as string;
            for (const row of rowsA) expect(inB.has(markerOf(row))).toBe(false);
            for (const row of rowsB) expect(inA.has(markerOf(row))).toBe(false);
          },
        ),
        { numRuns: 15 },
      );
    } finally {
      await connection.close();
    }
  }, 120_000);
});

describe('F8 — the change feed replays every event exactly once, from any cursor', () => {
  it('reading from position 0 to the end yields every event once, in position order', async () => {
    const connection = await db.openAppConnection();

    try {
      await fc.assert(
        fc.asyncProperty(
          fc.array(amountArb, { minLength: 4, maxLength: 12 }),
          fc.integer({ min: 1, max: 5 }),
          async (amounts, pageLimit) => {
            const org = await orgIn(db);
            const expected: MarkedEvent[] = [];
            for (const amount of amounts) {
              expected.push(await emitMarked(connection, org, amount));
            }

            const collected: ChangeFeedEvent[] = [];
            let cursor: string | undefined;
            let guard = 0;
            do {
              const page = await transactionOn(connection, org.ctx, () =>
                readChangeFeed({ limit: pageLimit, cursor }, org.ctx),
              ).promise;
              collected.push(...page.events);
              cursor = page.nextCursor ?? undefined;
              guard += 1;
              // A page is at most `pageLimit`, so this many iterations already covers
              // every generated run with headroom; a real infinite loop (a cursor
              // that never advances) trips this instead of hanging the suite.
              if (guard > amounts.length + 5) {
                throw new Error('The change feed did not terminate — cursor is not advancing.');
              }
            } while (cursor !== undefined);

            expect(collected).toHaveLength(expected.length);
            collected.forEach((event, index) => {
              expect(event.position).toBe(String(index + 1));
              const item = expected[index];
              if (item === undefined) throw new Error('More feed events than expected.');
              expectPayloadMatches(event, item);
              expect(event.actor).toEqual({ actorType: 'user', actorId: org.ctx.actorId });
            });
          },
        ),
        { numRuns: 12 },
      );
    } finally {
      await connection.close();
    }
  }, 120_000);

  it('replaying from an intermediate cursor yields exactly the suffix, once each', async () => {
    const connection = await db.openAppConnection();

    try {
      await fc.assert(
        fc.asyncProperty(fc.array(amountArb, { minLength: 4, maxLength: 12 }), async (amounts) => {
          const org = await orgIn(db);
          const expected: MarkedEvent[] = [];
          for (const amount of amounts) {
            expected.push(await emitMarked(connection, org, amount));
          }

          const midIndex = Math.floor(expected.length / 2);

          const firstPage = await transactionOn(connection, org.ctx, () =>
            readChangeFeed({ limit: midIndex }, org.ctx),
          ).promise;
          expect(firstPage.events).toHaveLength(midIndex);

          const suffix = await transactionOn(connection, org.ctx, () =>
            readChangeFeed({ limit: 200, cursor: firstPage.nextCursor ?? undefined }, org.ctx),
          ).promise;

          // Exactly the remainder, no repeat of anything the first page already
          // delivered and nothing skipped — the replay-from-cursor half of F8.
          expect(suffix.events).toHaveLength(expected.length - midIndex);
          expect(suffix.nextCursor).toBeNull();

          suffix.events.forEach((event, offset) => {
            const index = midIndex + offset;
            expect(event.position).toBe(String(index + 1));
            const item = expected[index];
            if (item === undefined) throw new Error('More suffix events than expected.');
            expectPayloadMatches(event, item);
          });

          // And re-reading from the very same cursor again is deterministic —
          // replay is just re-reading the same append-only rows (`change-feed.
          // service.ts`'s header), not a queue that advances on read.
          const suffixAgain = await transactionOn(connection, org.ctx, () =>
            readChangeFeed({ limit: 200, cursor: firstPage.nextCursor ?? undefined }, org.ctx),
          ).promise;
          expect(suffixAgain).toEqual(suffix);
        }),
        { numRuns: 12 },
      );
    } finally {
      await connection.close();
    }
  }, 120_000);
});
