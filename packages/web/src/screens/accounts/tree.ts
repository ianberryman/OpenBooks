import type { Account } from './accounts-api';

/**
 * The chart of accounts as a tree, built from the pages fetched so far.
 *
 * The subtlety is that the input is a *prefix* of a code-ordered list (D-21), not the whole
 * chart, so a child can arrive before its parent does — `1100.01` sorts before `900`, and
 * a page boundary can fall anywhere. A tree builder that assumed a complete set would
 * either drop those accounts or invent a parent for them. This one renders them at the top
 * level and marks them `detached`, so the screen can say why an account is not where the
 * user expects it and offer the next page.
 */
export interface AccountTreeRow {
  readonly account: Account;
  /** 0 for a top-level account. Bounded by the server at six generations. */
  readonly depth: number;
  /** The account this one rolls up into, when it is among the accounts loaded. */
  readonly parent: Account | null;
  /** It has a parent, and that parent is not on the pages fetched so far. */
  readonly detached: boolean;
}

/**
 * Depth-first over the loaded accounts, preserving the server's code ordering at every
 * level — the order the input arrives in is the order siblings appear in.
 */
export function buildAccountTree(accounts: readonly Account[]): readonly AccountTreeRow[] {
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const childrenByParent = new Map<string, Account[]>();
  const roots: Account[] = [];

  for (const account of accounts) {
    const parentId = account.parentAccountId;
    if (parentId === null || !byId.has(parentId)) {
      roots.push(account);
      continue;
    }

    const siblings = childrenByParent.get(parentId);
    if (siblings === undefined) childrenByParent.set(parentId, [account]);
    else siblings.push(account);
  }

  const rows: AccountTreeRow[] = [];
  const emitted = new Set<string>();

  function visit(account: Account, depth: number, parent: Account | null): void {
    rows.push({
      account,
      depth,
      parent,
      detached: parent === null && account.parentAccountId !== null,
    });
    emitted.add(account.id);

    for (const child of childrenByParent.get(account.id) ?? []) {
      visit(child, depth + 1, account);
    }
  }

  for (const root of roots) visit(root, 0, null);

  /**
   * Every loaded account appears exactly once, and this loop is what makes that a property
   * of the function rather than a consequence of the data.
   *
   * The walk above starts only from roots, so a cycle among the loaded accounts would
   * reach none of its members and they would vanish from the screen with nothing to
   * indicate it. The server refuses to build one (`account_parent_cycle`), which is an
   * argument for this never firing and not an argument for a chart of accounts that can
   * silently omit a row.
   */
  for (const account of accounts) {
    if (!emitted.has(account.id)) {
      rows.push({ account, depth: 0, parent: null, detached: true });
    }
  }

  return rows;
}
