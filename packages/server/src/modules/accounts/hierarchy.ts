import type { AccountType } from '@openbooks/shared-types';
import { ACCOUNT_MAX_DEPTH } from '@openbooks/shared-types';

import type { TenantDatabase } from '../../db';
import { assertFound, InternalError, PreconditionFailedError } from '../../errors';
import {
  ACCOUNT_RESOURCE,
  accountIdBytes,
  selectAccountByIdForUpdate,
  selectChildIds,
} from './accounts.repository';

/**
 * The three rules `accounts.parent_account_id` needs and the schema cannot give
 * (OB-035).
 *
 * The composite foreign key `(org_id, parent_account_id) → accounts (org_id, id)`
 * already makes a cross-org parent unrepresentable, so nothing here is doing
 * integrity work. What it does is everything the key is silent about:
 *
 *  1. **Cycles.** A self-referencing foreign key is perfectly satisfied by
 *     `a → b → a`. Every consumer of the tree — a subtotal, a chart render, an
 *     export — walks it, and a walk over a cycle does not return.
 *  2. **Depth.** Bounded at `ACCOUNT_MAX_DEPTH`; see that constant for why six
 *     and not five or twelve.
 *  3. **Type.** A parent's `type` must equal its children's. A subtotal over a
 *     subtree mixing an asset and an expense is not a wrong number, it is not a
 *     number — it has no line on any statement to appear on.
 *
 * ## The parent is resolved before it is referenced, and that is the 404
 *
 * Every path here reads the prospective parent through `tenantDb` and
 * `assertFound` *before* any statement names it. Skipping that and letting the
 * foreign key refuse would be equivalent for integrity and wrong for the error
 * surface: another org's account id would arrive as errno 1452 and become an
 * opaque 500, where acceptance A7 requires it to be indistinguishable from a
 * nonexistent one — a 404 with a byte-identical body.
 *
 * ## Why the ancestor walk locks, and what it costs
 *
 * Each step reads its row `FOR UPDATE`. Without that, two concurrent requests —
 * "make A a child of B" and "make B a child of A" — each read a snapshot in which
 * the other's change has not happened, both conclude there is no cycle, and both
 * commit. Under REPEATABLE READ, no amount of re-checking after the write finds
 * it either, because neither transaction can see the other. Locking is what
 * removes the interleaving: the first request holds A and then takes B, the
 * second holds B and wants A, and InnoDB resolves it — one of them proceeds and
 * the other is refused. This is asserted with two live connections in
 * `test/accounts/hierarchy.test.ts` rather than simulated sequentially, because a
 * sequential simulation of that race passes against code with no locking at all.
 *
 * The cost is a point read per generation and it is bounded by the depth rule:
 * at most `ACCOUNT_MAX_DEPTH` primary-key lookups going up, and at most
 * `ACCOUNT_MAX_DEPTH - 1` index range scans on `idx_accounts_org_parent` coming
 * down. Six and five, on a table with one row per account. The bound is what
 * makes the walk terminate at all — it stops after that many reads whether or not
 * it has found a root, so a tree that somehow held a cycle produces a fault
 * rather than a hung request.
 */

/**
 * The `parent_account_id` this account may be given, as bytes.
 *
 * `child.id` is `null` when the account does not exist yet. A new account is a
 * leaf, so its subtree height is one and only the parent's own depth is in play —
 * which is also why creation cannot produce a cycle and re-parenting can.
 */
export async function resolveAssignableParent(
  db: TenantDatabase,
  child: { readonly id: Buffer | null; readonly type: AccountType },
  parentAccountId: string,
): Promise<Buffer> {
  const parentId = assertFound(accountIdBytes(parentAccountId), ACCOUNT_RESOURCE);
  const parent = assertFound(await selectAccountByIdForUpdate(db, parentId), ACCOUNT_RESOURCE);

  if (parent.type !== child.type) throw typeMismatchError(child.type, parent.type);

  // Includes the parent itself, so its length is the parent's depth from the root.
  const ancestry = await ancestorsOf(db, parent.id, parent.parent_account_id);

  const childId = child.id;
  if (childId !== null && ancestry.some((ancestor) => ancestor.equals(childId))) {
    throw cycleError();
  }

  const height = childId === null ? 1 : await subtreeHeight(db, childId);
  if (ancestry.length + height > ACCOUNT_MAX_DEPTH) throw depthError();

  return parentId;
}

/**
 * Refuses a reclassification that would leave this account disagreeing with the
 * parent it is keeping.
 *
 * Only needed when the type moves and the parent does not: re-parenting checks
 * the same pair against the *new* parent, and doing both would take the same row
 * lock twice and produce a different error depending on which check ran first.
 */
export async function assertParentTypeMatches(
  db: TenantDatabase,
  parentId: Buffer,
  type: AccountType,
): Promise<void> {
  const parent = assertFound(await selectAccountByIdForUpdate(db, parentId), ACCOUNT_RESOURCE);
  if (parent.type !== type) throw typeMismatchError(type, parent.type);
}

/** Whether anything names this account as its parent. */
export async function hasChildren(db: TenantDatabase, id: Buffer): Promise<boolean> {
  return (await selectChildIds(db, [id])).length > 0;
}

/**
 * One token for "this account has children", two messages, on the same argument
 * `accountTypeLockedError` and `accountReferencedError` share
 * `account_has_postings`: the machine-readable fact is one fact, and a client
 * branching on it should not have to learn two names for it. The prose differs
 * because the remedies do.
 *
 * A reclassification is refused rather than cascaded. Moving a subtree from one
 * statement to another is not a rename — every balance under it changes which
 * report it appears on — so it is spelled as several deliberate operations
 * (detach the children, reclassify, re-attach) rather than one that quietly
 * restates a chart.
 */
export function reclassifyBlockedByChildrenError(): PreconditionFailedError {
  return new PreconditionFailedError(
    'account_has_children',
    'This account is a parent in the chart of accounts, and a parent and its children must ' +
      'share a type. Detach the accounts rolling up into it, reclassify, and re-attach them — ' +
      'each of those is a change to a report someone reads, so none of them happens implicitly.',
  );
}

export function deleteBlockedByChildrenError(): PreconditionFailedError {
  return new PreconditionFailedError(
    'account_has_children',
    'This account is a parent in the chart of accounts and cannot be deleted while anything ' +
      'rolls up into it. Re-parent its children — to another account or to the top level — ' +
      'and then delete it. Deleting a parent never deletes what is under it.',
  );
}

/**
 * The chain from `startId` up to its root, `startId` included.
 *
 * Bounded by `ACCOUNT_MAX_DEPTH`, which is what makes it total. Overrunning the
 * bound is an `InternalError` and not a refusal: every write path here enforces
 * the same bound, so a tree deeper than it — or one holding a cycle — is a state
 * this service should not have been able to produce, and reporting it as the
 * caller's mistake would send someone looking in the wrong place.
 */
async function ancestorsOf(
  db: TenantDatabase,
  startId: Buffer,
  startParentId: Buffer | null,
): Promise<readonly Buffer[]> {
  const chain: Buffer[] = [startId];
  let next = startParentId;

  while (next !== null) {
    if (chain.length >= ACCOUNT_MAX_DEPTH) {
      throw new InternalError(
        'Walking the account hierarchy exceeded the depth bound without reaching a root, so ' +
          'the stored chart either holds a cycle or is deeper than every write path permits.',
      );
    }

    const ancestor = await selectAccountByIdForUpdate(db, next);
    if (ancestor === undefined) {
      throw new InternalError(
        'An account names a parent that does not exist, which the composite foreign key on ' +
          'accounts.parent_account_id is supposed to make unrepresentable.',
      );
    }

    chain.push(ancestor.id);
    next = ancestor.parent_account_id;
  }

  return chain;
}

/**
 * Generations in the subtree rooted at `rootId`, the root counting as one.
 *
 * Level by level rather than row by row, so the cost is the *depth* of the
 * subtree and not its size. Stops at the bound: a caller only ever compares the
 * result against `ACCOUNT_MAX_DEPTH`, so measuring further would be work whose
 * answer changes nothing.
 *
 * Read without a lock, unlike the walk upwards. A create landing inside this
 * subtree while it is measured could leave the tree one generation over the bound
 * — a cosmetic overrun, where an unlocked cycle check is a non-terminating walk.
 * Locking every descendant to prevent it would take an unbounded number of row
 * locks to protect a bound that exists for readability.
 */
async function subtreeHeight(db: TenantDatabase, rootId: Buffer): Promise<number> {
  let frontier: readonly Buffer[] = [rootId];
  let height = 1;

  while (height < ACCOUNT_MAX_DEPTH) {
    const children = await selectChildIds(db, frontier);
    if (children.length === 0) break;

    height += 1;
    frontier = children;
  }

  return height;
}

/**
 * Distinct precondition tokens, unlike the two situations that share
 * `account_has_postings`.
 *
 * That pair shares a token because they are one fact — this account has postings
 * — reached by two routes. These are three different facts about a chart, and a
 * client that can tell them apart can say which one to fix; collapsing them would
 * leave "the parent was refused" as the only machine-readable content.
 */
function typeMismatchError(
  childType: AccountType,
  parentType: AccountType,
): PreconditionFailedError {
  return new PreconditionFailedError(
    'account_parent_type_mismatch',
    `A parent account must have the same type as the accounts rolling up into it. This ` +
      `account is ${childType} and the parent is ${parentType}, so a subtotal over the ` +
      'subtree would span two statements and mean nothing.',
  );
}

function cycleError(): PreconditionFailedError {
  return new PreconditionFailedError(
    'account_parent_cycle',
    'An account cannot be its own parent, nor a child of one of its own descendants. The ' +
      'chart of accounts is a tree, and every report that totals it walks that tree.',
  );
}

function depthError(): PreconditionFailedError {
  return new PreconditionFailedError(
    'account_depth_exceeded',
    `A chart of accounts may be at most ${String(ACCOUNT_MAX_DEPTH)} generations deep, and ` +
      'this would make it deeper. A chart that needs more levels is usually carrying a second ' +
      'axis — department, project, location — which dimensions report on without multiplying ' +
      'the chart.',
  );
}
