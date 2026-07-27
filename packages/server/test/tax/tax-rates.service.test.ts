import type { CreateTaxRateRequest } from '@openbooks/shared-types';
import { describe, expect, it } from 'vitest';

import { newUuid, tenantDb, orgScope as toOrgId } from '../../src/db';
import type { AccountType } from '../db';
import {
  ConflictError,
  NotFoundError,
  PermissionDeniedError,
  PreconditionFailedError,
  toWireError,
  ValidationError,
} from '../../src/errors';
import { getAccount } from '../../src/modules/accounts';
import {
  archiveTaxRate,
  createTaxRate,
  deleteTaxRate,
  getTaxRate,
  listTaxRates,
  unarchiveTaxRate,
  updateTaxRate,
} from '../../src/modules/tax';
import { deleteTaxRateRow, taxRateIdBytes } from '../../src/modules/tax/tax-rates.repository';
import type { ActorFixture } from './support';
import { actorIn, citeTaxRate, useServiceDatabase } from './support';

/**
 * The tax rates service against real MySQL (spec §11 — never SQLite, never
 * mocks).
 *
 * Everything goes through the exported service functions rather than the
 * repository, because the properties asserted are properties of the service
 * boundary: the permission check, the create-only percentage, the account rules,
 * the archive/delete split and the A7 miss all live there, and a test reaching the
 * repository would pass while the boundary was missing.
 *
 * The one deliberate exception is `deleteTaxRateRow`, called directly in the
 * delete section. That call is the point: it is the path with no pre-check in
 * front of it, so what refuses it can only be `fk_ar_document_lines_tax_rate`.
 */
const db = useServiceDatabase();

/** A liability account and an active rate on it, which most cases start from. */
async function taxAccount(actor: ActorFixture, type: AccountType = 'liability'): Promise<string> {
  const account = await db.factories.account({ orgId: actor.orgId, type });
  return account.uuid;
}

async function vatRate(
  actor: ActorFixture,
  overrides: Partial<CreateTaxRateRequest> = {},
): Promise<{ readonly id: string; readonly accountId: string }> {
  const accountId = overrides.accountId ?? (await taxAccount(actor));
  const created = await createTaxRate(
    { name: 'VAT 20%', percentage: '20', accountId, ...overrides },
    actor.ctx,
  );
  return { id: created.id, accountId };
}

describe('tax rates service', () => {
  describe('create, read, list', () => {
    it('round-trips a created rate through read and list', async () => {
      const actor = await actorIn(db);
      const accountId = await taxAccount(actor);

      const created = await createTaxRate(
        { name: 'VAT 20%', percentage: '20', accountId },
        actor.ctx,
      );

      expect(created).toMatchObject({
        name: 'VAT 20%',
        percentage: '20',
        accountId,
        appliesTo: 'both',
        isActive: true,
      });

      expect(await getTaxRate(created.id, actor.ctx)).toEqual(created);
      expect((await listTaxRates({}, actor.ctx)).items).toEqual([created]);
    });

    /**
     * Four decimals of a percent is the bound `rate.ts` chose *because* 8.875%
     * exists and basis points cannot express it. Asserted end to end — through the
     * `INT UNSIGNED` column and back — rather than against the primitive, which
     * already has its own property tests: the failure this catches is a column or
     * a conversion that quietly truncates, which no unit test of the parser sees.
     */
    it.each([
      ['20', '20'],
      ['8.875', '8.875'],
      ['0', '0'],
      ['100', '100'],
      ['8.0625', '8.0625'],
      // Canonical spelling on the way out: no trailing zeros, no trailing point,
      // so two clients comparing rates as strings agree.
      ['7.5000', '7.5'],
      ['0.0001', '0.0001'],
    ])('stores %s and returns it as %s', async (input, expected) => {
      const actor = await actorIn(db);
      const accountId = await taxAccount(actor);

      const created = await createTaxRate(
        { name: `Rate ${input}`, percentage: input, accountId },
        actor.ctx,
      );

      expect(created.percentage).toBe(expected);
      expect((await getTaxRate(created.id, actor.ctx)).percentage).toBe(expected);
    });

    /**
     * The parser is the authority (`taxPercentageSchema` hands the value to it),
     * so these are refusals of the wire form rather than of a re-derived rule.
     */
    it.each(['08', '20%', '-5', '0.00001', '101', '.5', '1e2', '+20', '1500.00', ''])(
      'refuses %s as a percentage',
      async (percentage) => {
        const actor = await actorIn(db);
        const accountId = await taxAccount(actor);

        await expect(
          createTaxRate({ name: 'Bad', percentage, accountId }, actor.ctx),
        ).rejects.toBeInstanceOf(ValidationError);
      },
    );

    it('refuses a duplicate name case-insensitively, naming it', async () => {
      const actor = await actorIn(db);
      const accountId = await taxAccount(actor);
      await createTaxRate({ name: 'VAT 20%', percentage: '20', accountId }, actor.ctx);

      await expect(
        createTaxRate({ name: 'vat 20%', percentage: '20', accountId }, actor.ctx),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it('trims a name so the uniqueness key sees the value the user sees', async () => {
      const actor = await actorIn(db);
      const accountId = await taxAccount(actor);

      const created = await createTaxRate(
        { name: '  VAT 20%  ', percentage: '20', accountId },
        actor.ctx,
      );
      expect(created.name).toBe('VAT 20%');
    });

    /**
     * `(created_at, id)` (D-21), and the cursor is exercised rather than assumed:
     * a page whose `nextCursor` did not resume where it left off would still pass
     * a single-page assertion.
     *
     * Asserted against the *unpaged* list rather than against insertion order, and
     * the difference is a real finding rather than a weakening. Five rates created
     * in a loop land inside one `DATETIME(3)` tick, so `created_at` ties and the
     * order is decided by `id` — a v4 uuid, which is not insertion order. The
     * ordering is still total, which is all D-21 needs and all a cursor needs; an
     * assertion on insertion order would have been asserting the clock's
     * resolution. What paging must guarantee is that the pages partition the list
     * in the list's own order, and that is what this compares.
     */
    it('pages the list on (created_at, id) with an opaque cursor', async () => {
      const actor = await actorIn(db);
      const accountId = await taxAccount(actor);

      for (const name of ['A', 'B', 'C', 'D', 'E']) {
        await createTaxRate({ name, percentage: '5', accountId }, actor.ctx);
      }

      const whole = await listTaxRates({}, actor.ctx);
      expect(whole.items).toHaveLength(5);
      expect(whole.nextCursor).toBeNull();

      const first = await listTaxRates({ limit: 2 }, actor.ctx);
      expect(first.items).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();

      const second = await listTaxRates({ limit: 2, cursor: first.nextCursor ?? '' }, actor.ctx);
      const third = await listTaxRates({ limit: 2, cursor: second.nextCursor ?? '' }, actor.ctx);

      expect([...first.items, ...second.items, ...third.items]).toEqual(whole.items);
      expect(third.nextCursor).toBeNull();
    });

    it('filters the list by the active flag', async () => {
      const actor = await actorIn(db);
      const accountId = await taxAccount(actor);

      const live = await createTaxRate({ name: 'Live', percentage: '20', accountId }, actor.ctx);
      const gone = await createTaxRate({ name: 'Gone', percentage: '17.5', accountId }, actor.ctx);
      await archiveTaxRate(gone.id, actor.ctx);

      expect((await listTaxRates({ isActive: true }, actor.ctx)).items.map((r) => r.id)).toEqual([
        live.id,
      ]);
      expect((await listTaxRates({ isActive: false }, actor.ctx)).items.map((r) => r.id)).toEqual([
        gone.id,
      ]);
    });
  });

  /**
   * D-35's rule, and the reason the whole module exists in the shape it does. The
   * assertion is not only that the call is refused but that the *stored* rate did
   * not move — a service that answered with a `ValidationError` after writing
   * would pass the first half.
   */
  describe('the percentage is create-only', () => {
    it('refuses a percentage in the patch and leaves the stored rate untouched', async () => {
      const actor = await actorIn(db);
      const rate = await vatRate(actor);

      await expect(
        updateTaxRate(rate.id, { percentage: '25' } as never, actor.ctx),
      ).rejects.toBeInstanceOf(ValidationError);

      expect((await getTaxRate(rate.id, actor.ctx)).percentage).toBe('20');
    });

    it('names the offending field rather than dropping it silently', async () => {
      const actor = await actorIn(db);
      const rate = await vatRate(actor);

      const error = await updateTaxRate(rate.id, { percentage: '25' } as never, actor.ctx).catch(
        (thrown: unknown) => thrown,
      );

      expect(error).toBeInstanceOf(ValidationError);
      expect(toWireError(error).details).toMatchObject({
        issues: [{ path: 'percentage' }],
      });
    });

    it('refuses isActive in the patch too — archiving is its own operation', async () => {
      const actor = await actorIn(db);
      const rate = await vatRate(actor);

      await expect(
        updateTaxRate(rate.id, { isActive: false } as never, actor.ctx),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('refuses an empty patch', async () => {
      const actor = await actorIn(db);
      const rate = await vatRate(actor);

      await expect(updateTaxRate(rate.id, {}, actor.ctx)).rejects.toBeInstanceOf(ValidationError);
    });

    /**
     * The correction path D-35 prescribes, asserted as a whole: a new rate at the
     * right percentage, the old one archived, both rows still readable. This is
     * what makes "which rate was this invoiced at" answerable after a change.
     */
    it('corrects a mistake with a new rate and an archive, keeping both rows', async () => {
      const actor = await actorIn(db);
      const accountId = await taxAccount(actor);

      const wrong = await createTaxRate(
        { name: 'VAT 17.5% (to 2011)', percentage: '17.5', accountId },
        actor.ctx,
      );
      const right = await createTaxRate(
        { name: 'VAT 20%', percentage: '20', accountId },
        actor.ctx,
      );
      await archiveTaxRate(wrong.id, actor.ctx);

      expect(await getTaxRate(wrong.id, actor.ctx)).toMatchObject({
        percentage: '17.5',
        isActive: false,
      });
      expect(await getTaxRate(right.id, actor.ctx)).toMatchObject({
        percentage: '20',
        isActive: true,
      });
    });
  });

  describe('the nominated account', () => {
    it.each(['liability', 'asset'] as const)('accepts a %s account', async (type) => {
      const actor = await actorIn(db);
      const accountId = await taxAccount(actor, type);

      const created = await createTaxRate({ name: type, percentage: '20', accountId }, actor.ctx);
      expect(created.accountId).toBe(accountId);
    });

    /**
     * Revenue and expense are the dangerous ones: the entry stays balanced, so the
     * trial balance shows nothing, and the profit is wrong by exactly the tax.
     */
    it.each(['revenue', 'expense', 'equity'] as const)('refuses a %s account', async (type) => {
      const actor = await actorIn(db);
      const accountId = await taxAccount(actor, type);

      const error = await createTaxRate(
        { name: type, percentage: '20', accountId },
        actor.ctx,
      ).catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(PreconditionFailedError);
      expect(toWireError(error).details).toMatchObject({
        precondition: 'tax_account_not_a_balance_sheet_account',
      });
    });

    it('refuses a deactivated account, at definition time rather than at approval', async () => {
      const actor = await actorIn(db);
      const account = await db.factories.account({
        orgId: actor.orgId,
        type: 'liability',
        isActive: false,
      });

      const error = await createTaxRate(
        { name: 'VAT 20%', percentage: '20', accountId: account.uuid },
        actor.ctx,
      ).catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(PreconditionFailedError);
      expect(toWireError(error).details).toMatchObject({ precondition: 'account_inactive' });
    });

    /**
     * A7, and the reason `resolveTaxAccount` reads through `tenantDb` instead of
     * letting `fk_tax_rates_account` refuse: the composite key would answer errno
     * 1452, which reaches `toWireError` unrecognised and becomes a 500 — a
     * distinguishable answer, and therefore an existence oracle.
     *
     * Byte-identical is asserted on the whole wire body, not on the status.
     */
    it('answers a cross-org account with the body a nonexistent one gets', async () => {
      const actor = await actorIn(db);
      const other = await actorIn(db);
      const foreign = await db.factories.account({ orgId: other.orgId, type: 'liability' });

      const crossOrg = await createTaxRate(
        { name: 'Cross', percentage: '20', accountId: foreign.uuid },
        actor.ctx,
      ).catch((thrown: unknown) => thrown);

      const nonexistent = await createTaxRate(
        { name: 'Nonexistent', percentage: '20', accountId: newUuid() },
        actor.ctx,
      ).catch((thrown: unknown) => thrown);

      expect(crossOrg).toBeInstanceOf(NotFoundError);
      expect(JSON.stringify(toWireError(crossOrg))).toBe(JSON.stringify(toWireError(nonexistent)));

      // And identical to what the *accounts* module answers for the same id. This
      // is what pins `ACCOUNT_RESOURCE` in `tax-rates.repository.ts` — a literal,
      // deliberately, rather than an import across module boundaries — to the one
      // in `accounts.repository.ts`. Renaming either token fails here.
      const fromAccounts = await getAccount(foreign.uuid, actor.ctx).catch(
        (thrown: unknown) => thrown,
      );
      expect(JSON.stringify(toWireError(crossOrg))).toBe(JSON.stringify(toWireError(fromAccounts)));
    });

    it('answers a malformed account id with the same 404, not a 400', async () => {
      const actor = await actorIn(db);

      const malformed = await createTaxRate(
        { name: 'Malformed', percentage: '20', accountId: 'not-a-uuid' },
        actor.ctx,
      ).catch((thrown: unknown) => thrown);

      // `z.uuid()` on the request schema catches this one first, which is correct
      // and is *not* an A7 hole: the refusal is a property of the string's shape
      // and is identical for every id, so it distinguishes no account from another.
      expect(malformed).toBeInstanceOf(ValidationError);
    });

    it('repoints a rate at a different account, revalidating it', async () => {
      const actor = await actorIn(db);
      const rate = await vatRate(actor);
      const replacement = await taxAccount(actor, 'asset');

      const updated = await updateTaxRate(rate.id, { accountId: replacement }, actor.ctx);
      expect(updated.accountId).toBe(replacement);

      const wrongType = await taxAccount(actor, 'revenue');
      await expect(
        updateTaxRate(rate.id, { accountId: wrongType }, actor.ctx),
      ).rejects.toBeInstanceOf(PreconditionFailedError);
      expect((await getTaxRate(rate.id, actor.ctx)).accountId).toBe(replacement);
    });
  });

  /**
   * The decision `index.ts` argues: a zero-rated supply is a rate of 0%, an exempt
   * supply is no rate at all, and the two must stay tellable apart because a VAT
   * return counts them in different boxes.
   */
  describe('zero-rated is a rate; exempt is the absence of one', () => {
    it('creates a 0% rate as an ordinary rate', async () => {
      const actor = await actorIn(db);
      const accountId = await taxAccount(actor);

      const zero = await createTaxRate(
        { name: 'Zero-rated', percentage: '0', accountId },
        actor.ctx,
      );

      expect(zero).toMatchObject({ percentage: '0', isActive: true });
      expect((await listTaxRates({}, actor.ctx)).items.map((r) => r.id)).toContain(zero.id);
    });

    /**
     * The structural half, asserted against the schema rather than against this
     * service: a zero-rated line cites the rate and an exempt line cites nothing,
     * and `chk_ar_document_lines_tax_needs_rate` permits the second only because
     * its tax is zero. If the two ever became one state, this is the assertion
     * that fails.
     */
    it('lets a document line be zero-rated or exempt, distinguishably', async () => {
      const actor = await actorIn(db);
      const accountId = await taxAccount(actor);
      const zero = await createTaxRate(
        { name: 'Zero-rated', percentage: '0', accountId },
        actor.ctx,
      );
      const expenseAccount = await db.factories.account({ orgId: actor.orgId, type: 'revenue' });

      await citeTaxRate(db, 'ar', actor, zero.id, expenseAccount.id);

      const scoped = tenantDb(toOrgId(actor.orgUuid));
      const lines = await scoped
        .selectFrom('ar_document_lines')
        .select(['tax_rate_id', 'tax_amount_minor'])
        .execute();

      expect(lines).toHaveLength(1);
      expect(lines[0]?.tax_rate_id).not.toBeNull();

      // The exempt line: no rate, zero tax, accepted by the CHECK.
      await expect(
        scoped
          .insertInto('ar_document_lines')
          .values({
            document_id: (
              await scoped.selectFrom('ar_documents').select('id').executeTakeFirstOrThrow()
            ).id,
            line_number: 2,
            quantity_micros: 1_000_000n,
            unit_amount_minor: 50_00n,
            account_id: expenseAccount.id,
            tax_rate_id: null,
            line_amount_minor: 50_00n,
            tax_amount_minor: 0n,
          })
          .execute(),
      ).resolves.toBeDefined();
    });
  });

  describe('archive and unarchive', () => {
    it('archives idempotently and unarchives back', async () => {
      const actor = await actorIn(db);
      const rate = await vatRate(actor);

      expect((await archiveTaxRate(rate.id, actor.ctx)).isActive).toBe(false);
      expect((await archiveTaxRate(rate.id, actor.ctx)).isActive).toBe(false);
      expect((await unarchiveTaxRate(rate.id, actor.ctx)).isActive).toBe(true);
    });

    /**
     * Archiving must not re-check the account, or an org whose tax account was
     * deactivated could never retire the rate pointing at it — a state with no
     * exit.
     */
    it('archives a rate whose account has since been deactivated', async () => {
      const actor = await actorIn(db);
      const account = await db.factories.account({ orgId: actor.orgId, type: 'liability' });
      const rate = await vatRate(actor, { accountId: account.uuid });

      await tenantDb(toOrgId(actor.orgUuid))
        .updateTable('accounts')
        .set({ is_active: 0 })
        .where('id', '=', account.id)
        .execute();

      expect((await archiveTaxRate(rate.id, actor.ctx)).isActive).toBe(false);
    });
  });

  describe('delete is for a rate no document cites', () => {
    it('deletes a rate nothing references', async () => {
      const actor = await actorIn(db);
      const rate = await vatRate(actor);

      await deleteTaxRate(rate.id, actor.ctx);
      await expect(getTaxRate(rate.id, actor.ctx)).rejects.toBeInstanceOf(NotFoundError);
    });

    it.each(['ar', 'ap'] as const)(
      'refuses a rate an %s document line cites, naming the side',
      async (side) => {
        const actor = await actorIn(db);
        const rate = await vatRate(actor);
        const lineAccount = await db.factories.account({ orgId: actor.orgId, type: 'revenue' });

        await citeTaxRate(db, side, actor, rate.id, lineAccount.id);

        const error = await deleteTaxRate(rate.id, actor.ctx).catch((thrown: unknown) => thrown);

        expect(error).toBeInstanceOf(PreconditionFailedError);
        expect(toWireError(error).details).toMatchObject({ precondition: 'tax_rate_in_use' });
        expect(toWireError(error).message).toContain(
          side === 'ar' ? 'invoice or credit note' : 'bill or vendor credit',
        );

        // Still readable and still archivable — the remedy the message points at.
        expect((await archiveTaxRate(rate.id, actor.ctx)).isActive).toBe(false);
      },
    );

    /**
     * The constraint is the guarantee; the pre-check is only a better message.
     *
     * This goes straight to the repository, which has no pre-check in front of it,
     * so the only thing that can refuse the statement is
     * `fk_ar_document_lines_tax_rate`'s `ON DELETE RESTRICT`. It is what would
     * catch the delete that loses the race with a concurrent invoice line, and it
     * is what keeps that race a `precondition_failed` rather than errno 1451
     * arriving at `toWireError` as a 500.
     *
     * Deleting the pre-checks from `deleteTaxRate` leaves every other case in this
     * file passing; deleting the `isStillReferencedError` translation fails only
     * this one.
     */
    it('is refused by the foreign key itself, translated rather than thrown raw', async () => {
      const actor = await actorIn(db);
      const rate = await vatRate(actor);
      const lineAccount = await db.factories.account({ orgId: actor.orgId, type: 'revenue' });

      await citeTaxRate(db, 'ar', actor, rate.id, lineAccount.id);

      const scoped = tenantDb(toOrgId(actor.orgUuid));
      const id = taxRateIdBytes(rate.id);
      if (id === undefined) throw new Error('unreachable: the created id is a uuid');

      const error = await deleteTaxRateRow(scoped, id).catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(PreconditionFailedError);
      expect(toWireError(error).details).toMatchObject({ precondition: 'tax_rate_in_use' });
    });

    it('answers a cross-org rate with the body a nonexistent one gets', async () => {
      const actor = await actorIn(db);
      const other = await actorIn(db);
      const foreign = await vatRate(other);

      const crossOrg = await getTaxRate(foreign.id, actor.ctx).catch((thrown: unknown) => thrown);
      const nonexistent = await getTaxRate(newUuid(), actor.ctx).catch((thrown: unknown) => thrown);

      expect(crossOrg).toBeInstanceOf(NotFoundError);
      expect(JSON.stringify(toWireError(crossOrg))).toBe(JSON.stringify(toWireError(nonexistent)));

      // And the same for every operation that names a rate, so none of them is the
      // one that leaks.
      await expect(deleteTaxRate(foreign.id, actor.ctx)).rejects.toBeInstanceOf(NotFoundError);
      await expect(archiveTaxRate(foreign.id, actor.ctx)).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        updateTaxRate(foreign.id, { name: 'Renamed' }, actor.ctx),
      ).rejects.toBeInstanceOf(NotFoundError);

      // The foreign rate is untouched, which is what "indistinguishable from
      // nonexistent" has to mean in the write direction as well as the read one.
      expect(await getTaxRate(foreign.id, other.ctx)).toMatchObject({ isActive: true });
    });
  });

  describe('permissions', () => {
    it('lets a read-only role read and refuses it every write', async () => {
      const owner = await actorIn(db);
      const rate = await vatRate(owner);

      const reader = await actorIn(db, 'readOnly');
      // A different org, so the reader's own rate list is the one being asserted.
      expect((await listTaxRates({}, reader.ctx)).items).toEqual([]);

      await expect(
        createTaxRate(
          { name: 'X', percentage: '20', accountId: await taxAccount(reader) },
          reader.ctx,
        ),
      ).rejects.toBeInstanceOf(PermissionDeniedError);
      await expect(deleteTaxRate(rate.id, reader.ctx)).rejects.toBeInstanceOf(
        PermissionDeniedError,
      );
      await expect(archiveTaxRate(rate.id, reader.ctx)).rejects.toBeInstanceOf(
        PermissionDeniedError,
      );
    });

    /**
     * `requirePermission` runs before `parseInput`, so a caller without authority
     * learns that and nothing else. A service that validated first would answer a
     * `validation_failed` naming fields — a description of an API surface the
     * caller is not entitled to.
     */
    it('checks the permission before parsing the payload', async () => {
      const reader = await actorIn(db, 'readOnly');

      await expect(
        createTaxRate({ name: '', percentage: 'nonsense', accountId: 'x' }, reader.ctx),
      ).rejects.toBeInstanceOf(PermissionDeniedError);
    });

    it('lets ar_only read rates and not write them', async () => {
      const actor = await actorIn(db, 'arOnly');

      expect((await listTaxRates({}, actor.ctx)).items).toEqual([]);
      await expect(
        createTaxRate(
          { name: 'X', percentage: '20', accountId: await taxAccount(actor) },
          actor.ctx,
        ),
      ).rejects.toBeInstanceOf(PermissionDeniedError);
    });
  });

  /**
   * `applies_to` (OB-066a). The three values are storable now, and the ones a
   * document may cite are enforced where a line picks a rate rather than here —
   * `test/invoices` and `test/bills` own that half.
   */
  describe('appliesTo', () => {
    it('defaults to both when the field is omitted', async () => {
      const actor = await actorIn(db);
      const accountId = await taxAccount(actor);

      const created = await createTaxRate(
        { name: 'VAT 20%', percentage: '20', accountId },
        actor.ctx,
      );
      expect(created.appliesTo).toBe('both');
    });

    it.each(['sales', 'purchases', 'both'] as const)(
      'stores %s and reads it back',
      async (value) => {
        const actor = await actorIn(db);
        const accountId = await taxAccount(actor);

        const created = await createTaxRate(
          { name: value, percentage: '20', accountId, appliesTo: value },
          actor.ctx,
        );
        expect(created.appliesTo).toBe(value);
        expect((await getTaxRate(created.id, actor.ctx)).appliesTo).toBe(value);
      },
    );

    /**
     * Mutable where the percentage is not, which is the contrast
     * `updateTaxRateRequestSchema` draws: narrowing a rate restates no posted
     * journal, because the document line recorded the tax it computed.
     */
    it('narrows an existing rate', async () => {
      const actor = await actorIn(db);
      const rate = await vatRate(actor);

      const updated = await updateTaxRate(rate.id, { appliesTo: 'purchases' }, actor.ctx);
      expect(updated.appliesTo).toBe('purchases');
      // The percentage is untouched: narrowing is not a rate change (D-35).
      expect(updated.percentage).toBe('20');
    });

    /**
     * The filter asks which rates a document of that kind may *use*, so it is not
     * an equality: an unrestricted rate is offered to both pickers. An equality
     * would hide every `both` rate, which is every rate an org that does not
     * reclaim input tax holds — the failure this test exists to catch.
     */
    it('filters by usability rather than by equality', async () => {
      const actor = await actorIn(db);
      const accountId = await taxAccount(actor);

      const both = await createTaxRate(
        { name: 'Standard', percentage: '20', accountId, appliesTo: 'both' },
        actor.ctx,
      );
      const salesOnly = await createTaxRate(
        { name: 'Output only', percentage: '5', accountId, appliesTo: 'sales' },
        actor.ctx,
      );
      const purchasesOnly = await createTaxRate(
        { name: 'Input only', percentage: '5', accountId, appliesTo: 'purchases' },
        actor.ctx,
      );

      const ids = async (value: 'sales' | 'purchases' | 'both'): Promise<readonly string[]> =>
        (await listTaxRates({ appliesTo: value }, actor.ctx)).items.map((rate) => rate.id).sort();

      expect(await ids('sales')).toEqual([both.id, salesOnly.id].sort());
      expect(await ids('purchases')).toEqual([both.id, purchasesOnly.id].sort());
      // `both` asks for no restriction, so it filters nothing.
      expect(await ids('both')).toEqual([both.id, salesOnly.id, purchasesOnly.id].sort());
    });
  });
});
