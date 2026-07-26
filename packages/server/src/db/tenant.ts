import { sql } from 'kysely';
import type {
  DeleteResult,
  Expression,
  InsertObject,
  InsertResult,
  Kysely,
  SqlBool,
  Transaction,
  UpdateObject,
  UpdateResult,
} from 'kysely';

import type { DB } from './generated';
import type { TenantTableName } from './tenant-tables';
import { ambientTransaction, runInTransactionScope } from './transaction-scope';

/** An org identifier as stored: a UUID in BINARY(16), plain hex byte order. */
export type OrgId = Buffer;

/**
 * Either a pooled connection or an open transaction.
 *
 * Not a union of the two: `Transaction<DB>` extends `Kysely<DB>`, and writing the
 * union makes every builder method resolve to a union of overload sets that
 * TypeScript then refuses to call. The runtime distinction is made by
 * `isTransaction` where it actually matters.
 */
type Executor = Kysely<DB>;

/**
 * Insert shape for a tenant table, with `org_id` removed.
 *
 * This is what makes the guarantee ergonomic rather than merely enforced. A
 * caller cannot supply the wrong `org_id`, because there is nowhere to put one.
 * Compare the alternative where `org_id` stays in the shape and the wrapper
 * validates it: that needs a runtime check, the check needs a test, and the
 * mistake stays expressible.
 */
export type TenantInsert<T extends TenantTableName> = Omit<InsertObject<DB, T>, 'org_id'>;

/** Update shape for a tenant table. `org_id` is not reassignable. */
export type TenantUpdate<T extends TenantTableName> = Omit<UpdateObject<DB, T, T>, 'org_id'>;

/**
 * Org-scoped database access. The only way service code reaches a tenant table.
 *
 * Every query built here carries `<table>.org_id = ?` before the caller can add
 * anything, and the methods accept only `TenantTableName`, so an unscoped tenant
 * query does not typecheck. Non-tenant tables (`users`, `permissions`, `roles`)
 * are unreachable from here by design and go through `systemDb`.
 *
 * See ROADMAP D-01 for the exact scope of the guarantee: tenant tables are
 * unreachable without scope, the raw handle has no public name, and an import
 * boundary rule fails the build on any attempt to go around this class.
 */
export class TenantDatabase {
  readonly #executor: Executor;
  readonly #orgId: OrgId;

  constructor(executor: Executor, orgId: OrgId) {
    this.#executor = executor;
    this.#orgId = orgId;
  }

  get orgId(): OrgId {
    return this.#orgId;
  }

  /**
   * Return types on these four are inferred rather than declared.
   *
   * Kysely's builder types are considerably more intricate than they look —
   * `selectFrom` returns `SelectFrom<DB, never, T>`, which resolves through
   * `ExtractTableAlias` and is not the same type as a hand-written
   * `SelectQueryBuilder<DB, T, object>`. Restating them by hand produces types
   * that are subtly wrong and drift on every Kysely upgrade. Inference through
   * `withOrgScope`, which is identity in the builder type, gives callers exactly
   * Kysely's own type with the scoping already applied.
   */
  selectFrom<T extends TenantTableName>(table: T) {
    return withOrgScope(this.#executor.selectFrom(table), this.#orgPredicate(table));
  }

  insertInto<T extends TenantTableName>(table: T) {
    const executor = this.#executor;
    const orgId = this.#orgId;

    return {
      values(rows: TenantInsert<T> | readonly TenantInsert<T>[]) {
        const list: readonly TenantInsert<T>[] = Array.isArray(rows) ? rows : [rows];
        // The spread is the injection point. org_id goes after the spread, so a
        // caller who somehow smuggles one in cannot override the scope.
        const scoped = list.map((row) => ({ ...row, org_id: orgId }) as InsertObject<DB, T>);
        return executor.insertInto(table).values(scoped);
      },
    };
  }

  /**
   * Returns the scoped builder directly, so the caller uses Kysely's own `.set()`.
   *
   * `insertInto` above hides `org_id` from the value shape, and the symmetrical
   * move here would be to hide it from the update shape too. That is not done,
   * for a reason worth stating rather than leaving as an accident: wrapping
   * `.set()` means re-declaring its overloads through a generic table parameter,
   * which TypeScript resolves to a union of incompatible signatures, and the casts
   * needed to force it through are exactly the sort of fragile type surgery that
   * breaks on a Kysely upgrade.
   *
   * The residual gap is that a caller can write `.set({ org_id: otherOrg })` and
   * move one of their own rows to another org. That is not a read leak and not a
   * cross-org write — the WHERE clause still confines the statement to this org's
   * rows — and for the ledger tables the composite foreign keys reject it anyway,
   * since a journal's `org_id` must agree with its lines'. Accepted knowingly; if
   * it ever matters, the fix is a lint rule banning `org_id` in a `.set()` object,
   * not a more clever type.
   */
  updateTable<T extends TenantTableName>(table: T) {
    return withOrgScope(this.#executor.updateTable(table), this.#orgPredicate(table));
  }

  deleteFrom<T extends TenantTableName>(table: T) {
    return withOrgScope(this.#executor.deleteFrom(table), this.#orgPredicate(table));
  }

  /**
   * Runs `body` inside a transaction, scoped to the same org.
   *
   * Re-wrapping rather than handing out the raw `Transaction<DB>` matters: the
   * posting repository does all its work in one transaction (spec §11 requires a
   * posting racing a period lock to leave nothing half-written), so an unscoped
   * transactional handle would make the most safety-critical path in the system
   * the one place org scoping did not apply.
   */
  async transaction<R>(body: (trx: TenantDatabase) => Promise<R>): Promise<R> {
    // Joining an ambient transaction is checked first, and it is what makes
    // composition work: `withIdempotency(..., () => postJournal(...))` has two
    // services each opening a transaction, and without this they get two, on two
    // connections, so a rollback of one leaves the other committed. See
    // transaction-scope.ts for why this is ambient rather than a parameter.
    const ambient = ambientTransaction();
    if (ambient !== undefined) {
      return body(new TenantDatabase(ambient, this.#orgId));
    }

    // MySQL has no true nested transactions, only savepoints, so a wrapper that
    // already holds one joins it rather than pretending to start another.
    if (isTransaction(this.#executor)) {
      return body(this);
    }

    return this.#executor
      .transaction()
      .execute((trx) =>
        runInTransactionScope(trx, () => body(new TenantDatabase(trx, this.#orgId))),
      );
  }

  /**
   * The scoping predicate, as a typed SQL expression.
   *
   * Written with `sql` rather than `.where('org_id', '=', id)` because Kysely
   * cannot see through the generic `T` to know `DB[T]` has an `org_id` column,
   * even though `TenantTableName` guarantees it — resolving that through the
   * builder's reference types requires casts that fight the library. An
   * `Expression<SqlBool>` is accepted by every builder regardless of the table
   * generic, so this stays cast-free and the types keep working.
   *
   * The reference is qualified (`accounts.org_id`, not `org_id`) so a query
   * joining two tenant tables is unambiguous. A bare `org_id` would raise
   * "ambiguous column" at runtime — a failure that only appears once someone
   * writes the join, which is the worst time to discover it.
   */
  #orgPredicate<T extends TenantTableName>(table: T): Expression<SqlBool> {
    return sql<SqlBool>`${sql.ref(`${table}.org_id`)} = ${this.#orgId}`;
  }
}

/** The one builder capability this wrapper needs: add a boolean predicate. */
interface Whereable<Self> {
  where(expression: Expression<SqlBool>): Self;
}

/**
 * Applies the org predicate to a query builder.
 *
 * The assertion exists because `TenantTableName` is a union and the builder
 * methods are generic over it, so `builder.where(...)` resolves to a *union of
 * overload sets* that TypeScript then declines to call — even though every member
 * of that union accepts an `Expression<SqlBool>` and returns its own type.
 *
 * Narrowing to this one-method interface says exactly that, and no more. It is an
 * assertion about Kysely's overload resolution, not about the schema: whether the
 * column exists is settled by the derivation in `tenant-tables.ts`, and if that
 * stops holding, the derivation stops compiling rather than this function
 * silently doing the wrong thing.
 *
 * Confined to this function so it is the only place in the codebase where a query
 * builder's type is loosened, and every tenant query passes through it.
 */
function withOrgScope<B>(builder: B, predicate: Expression<SqlBool>): B {
  return (builder as Whereable<B>).where(predicate);
}

function isTransaction(executor: Executor): executor is Transaction<DB> {
  return 'isTransaction' in executor && executor.isTransaction === true;
}

export type { InsertResult, UpdateResult, DeleteResult };
