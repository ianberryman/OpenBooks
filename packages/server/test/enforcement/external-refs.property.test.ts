import type { ExternalRef, ExternalRefEntityType } from '@openbooks/shared-types';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createExternalRef, EXTERNAL_REF_ENTITY_TYPES } from '../../src/modules/external-refs';
import { newUuid, useTestDatabase } from '../db';

import {
  connectionId,
  CONTENTION_WAIT_MS,
  countExternalRefs,
  delay,
  orgIn,
  parkedTransactionOn,
  transactionOn,
} from './event-outbox-support';

/**
 * F9 (OB-107; ROADMAP D-58; spec §11): **`external_refs` re-import collapses to
 * one entity** — the E1-style idempotency `createExternalRef` gives one layer
 * above the ledger's own idempotency key (`external-refs.service.ts`'s header:
 * "D-04's idempotency lifted from a one-shot `Idempotency-Key` to a durable
 * external identity").
 *
 * Two properties:
 *
 *  - **Sequential re-import.** Creating the same `(externalSystem, entityType,
 *    externalId) → entityId` mapping N times, one after another, yields exactly
 *    one `external_refs` row and returns the same entity every time.
 *  - **Concurrent re-import** (CLAUDE.md: "prove contention, don't assume it").
 *    Two callers racing to create the *same* identity: the loser's own insert
 *    attempt collides with the winner's still-uncommitted row on
 *    `uq_external_refs_external` and blocks — proven by parking the winner
 *    mid-transaction and observing the loser has not settled — and once the
 *    winner commits, the loser's blocked insert surfaces as a duplicate key,
 *    which `resolveExistingOrConflict`'s raced path catches and resolves to the
 *    same committed row (`external-refs.service.ts`'s own argument for why the
 *    resolution logic is one function rather than two).
 *
 * Real MySQL, no pool: see `event-outbox-support.ts`'s header. Every call here is
 * pinned to a chosen `openAppConnection()` handle via `transactionOn` /
 * `parkedTransactionOn`, matching `test/invoices/approve-race.test.ts`'s own
 * "two callers approving the same invoice" shape — this is that same race, one
 * layer up, over a unique index rather than a document's row lock.
 */
const db = useTestDatabase();

const entityTypeArb: fc.Arbitrary<ExternalRefEntityType> = fc.constantFrom(
  ...EXTERNAL_REF_ENTITY_TYPES,
);

describe('F9 — external_refs re-import collapses to one entity (D-58)', () => {
  it('creating the same identity N times yields one row, same entity each time', async () => {
    const connection = await db.openAppConnection();

    try {
      await fc.assert(
        fc.asyncProperty(
          entityTypeArb,
          fc.integer({ min: 2, max: 5 }),
          async (entityType, repeats) => {
            const org = await orgIn(db);
            const externalSystem = 'quickbooks';
            const externalId = newUuid();
            const entityId = newUuid();

            const results: ExternalRef[] = [];
            for (let attempt = 0; attempt < repeats; attempt += 1) {
              const result = await transactionOn(connection, org.ctx, () =>
                createExternalRef({ externalSystem, entityType, externalId, entityId }, org.ctx),
              ).promise;
              results.push(result);
            }

            const first = results[0];
            if (first === undefined) throw new Error('No results — repeats must be at least 1.');

            for (const result of results) {
              expect(result.id).toBe(first.id);
              expect(result.entityId).toBe(entityId);
              expect(result.externalId).toBe(externalId);
              expect(result.entityType).toBe(entityType);
              expect(result.externalSystem).toBe(externalSystem);
            }

            expect(await countExternalRefs(db.app, org.orgId)).toBe(1);
          },
        ),
        { numRuns: 15 },
      );
    } finally {
      await connection.close();
    }
  }, 120_000);
});

describe('two callers racing to create the same external identity (D-58, F9)', () => {
  it('serialize on the unique index and both resolve to the one row that committed', async () => {
    const org = await orgIn(db);
    const first = await db.openAppConnection();
    const second = await db.openAppConnection();

    try {
      expect(await connectionId(first.db)).not.toBe(await connectionId(second.db));

      const request = {
        externalSystem: 'quickbooks',
        entityType: 'invoice' as const,
        externalId: newUuid(),
        entityId: newUuid(),
      };

      // The winner has inserted its row, uncommitted, and holds
      // `uq_external_refs_external`'s lock on this identity.
      const winner = parkedTransactionOn(first, org.ctx, () => createExternalRef(request, org.ctx));
      const created = await winner.parked;

      const loser = transactionOn(second, org.ctx, () => createExternalRef(request, org.ctx));
      await delay(CONTENTION_WAIT_MS);

      // The loser's pre-check (`resolveExistingOrConflict`) is a plain snapshot
      // read and cannot see the winner's uncommitted row, so it proceeds to its
      // own `insertExternalRef` — which blocks behind the winner's uncommitted
      // duplicate key. Without a real lock here, the loser would not block at
      // all, and this is the assertion that would catch that.
      expect(loser.hasSettled()).toBe(false);

      winner.commit();
      await winner.promise;

      // The loser's blocked insert now surfaces as a duplicate key, caught and
      // resolved to the exact row the winner committed.
      const resolved = await loser.promise;
      expect(resolved).toEqual(created);

      expect(await countExternalRefs(db.app, org.orgId)).toBe(1);
    } finally {
      await first.close();
      await second.close();
    }
  });
});
