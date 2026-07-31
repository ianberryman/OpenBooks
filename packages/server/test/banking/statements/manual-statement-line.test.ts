import { beforeEach, describe, expect, it } from 'vitest';

import { createManualStatementLine, listStatementLines } from '../../../src/modules/banking';
import { computeFingerprint } from '../../../src/modules/banking/statements/fingerprint';
import type { Scene } from '../support';
import { linesOf, sceneIn, useServiceDatabase, withContext } from '../support';

/**
 * A statement line entered by hand (for the match/reconcile flow when a transaction the
 * bank shows has no file yet). The claim worth pinning is not that a row is written — it is
 * that a hand-entered line is *the same kind of thing* as an imported one: no import, the
 * signed amount, and the very fingerprint and occurrence index an import would compute, so
 * the two dedupe when the file finally lands (D-42). Cross-org 404 and the `banking.import`
 * gate are asserted in the enforcement suites; this is the behaviour.
 */

const db = useServiceDatabase();
let scene: Scene;

beforeEach(async () => {
  scene = await sceneIn(db);
});

function create(input: {
  readonly postedDate: string;
  readonly amount: string;
  readonly description: string;
  readonly bankReference?: string | null;
}) {
  return withContext(scene.ctx, () =>
    createManualStatementLine({ bankAccountId: scene.bankAccountUuid, ...input }, scene.ctx),
  );
}

describe('a statement line entered by hand', () => {
  it('is stored with no import, the signed amount, and shows up uncleared', async () => {
    const line = await create({ postedDate: '2026-02-10', amount: '-4500', description: 'Bank fee' });

    expect(line.importId).toBeNull();
    expect(line.amount).toBe('-4500');
    expect(line.occurrenceIndex).toBe(0);
    expect(line.clearing).toBeNull();

    const page = await withContext(scene.ctx, () =>
      listStatementLines(
        { bankAccountId: scene.bankAccountUuid, cleared: false, limit: 50 },
        scene.ctx,
      ),
    );
    expect(page.items.map((item) => item.id)).toContain(line.id);
  });

  it('carries the same fingerprint an import would, so the two dedupe (D-42)', async () => {
    const line = await create({ postedDate: '2026-02-11', amount: '150000', description: 'Deposit' });

    expect(line.fingerprint).toBe(
      computeFingerprint({
        postedDate: '2026-02-11',
        amount: 150000n,
        description: 'Deposit',
        bankReference: null,
      }),
    );
  });

  it('two genuinely identical hand entries both survive, at occurrence 0 and 1', async () => {
    const first = await create({ postedDate: '2026-02-12', amount: '450', description: 'Coffee' });
    const second = await create({ postedDate: '2026-02-12', amount: '450', description: 'Coffee' });

    expect(first.occurrenceIndex).toBe(0);
    expect(second.occurrenceIndex).toBe(1);
    expect(await linesOf(db.app, scene.bankAccountId)).toHaveLength(2);
  });

  it('refuses a zero amount — a statement line that moved no money is nonsense', async () => {
    await expect(
      create({ postedDate: '2026-02-13', amount: '0', description: 'Nothing' }),
    ).rejects.toThrow();
  });
});
