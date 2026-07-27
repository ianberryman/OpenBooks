/**
 * Flat report rows to a display order (OB-052; acceptance B7).
 *
 * The P&L and the balance sheet publish their rows as a **flat list with a
 * `parentAccountId` pointer**, and that is deliberate rather than a shortcut: a recursive
 * schema needs an `$defs` id to reference itself, and the shape is flat so that the
 * published document stays one component per row. Building the tree is therefore the
 * renderer's job, and this is the one place it is done — the two statements and any later
 * one get the same ordering, indentation, and the same guarantee below.
 *
 * **The guarantee: every row is emitted exactly once.** A row is what a section total was
 * summed from, so dropping one prints a statement whose rows do not add up to its own
 * total, and the reader has no way to see which row is missing. Rows whose parent is not
 * in this section — which the server's own hierarchy rule makes impossible, since a
 * parent's type equals its children's — are emitted as roots rather than skipped, and a
 * cycle (likewise unrepresentable, B7) terminates instead of hanging the tab.
 */

export interface HierarchyRow {
  readonly accountId: string;
  readonly parentAccountId: string | null;
}

export interface TreeLine<Row extends HierarchyRow> {
  readonly row: Row;
  readonly depth: number;
  /**
   * Whether anything rolls up into this row. The `subtotal` column is printed only for
   * these: a leaf's subtotal equals its own amount, and printing the same figure in two
   * columns invites a reader — or a later change — to total the wrong one.
   */
  readonly hasChildren: boolean;
}

export function buildRowTree<Row extends HierarchyRow>(
  rows: readonly Row[],
): readonly TreeLine<Row>[] {
  const byId = new Map<string, Row>(rows.map((row) => [row.accountId, row]));

  const children = new Map<string, Row[]>();
  const roots: Row[] = [];
  for (const row of rows) {
    const parentId = row.parentAccountId;
    if (parentId === null || !byId.has(parentId)) {
      roots.push(row);
      continue;
    }
    const siblings = children.get(parentId);
    if (siblings === undefined) children.set(parentId, [row]);
    else siblings.push(row);
  }

  const lines: TreeLine<Row>[] = [];
  const visited = new Set<string>();

  // Iterative, so a deep chart cannot overflow the stack, and depth-first so a parent is
  // immediately followed by its subtree — the order the indentation is claiming.
  const stack: { row: Row; depth: number }[] = [...roots]
    .reverse()
    .map((row) => ({ row, depth: 0 }));
  while (stack.length > 0) {
    const next = stack.pop();
    if (next === undefined) break;
    if (visited.has(next.row.accountId)) continue;
    visited.add(next.row.accountId);

    const kids = children.get(next.row.accountId) ?? [];
    lines.push({ row: next.row, depth: next.depth, hasChildren: kids.length > 0 });
    for (let index = kids.length - 1; index >= 0; index -= 1) {
      const kid = kids[index];
      if (kid !== undefined) stack.push({ row: kid, depth: next.depth + 1 });
    }
  }

  // Anything a cycle kept unreachable. Printed flat rather than lost, for the reason in
  // the module header: an unprinted row is a total that does not add up.
  for (const row of rows) {
    if (!visited.has(row.accountId)) {
      lines.push({ row, depth: 0, hasChildren: false });
    }
  }

  return lines;
}

/**
 * Drops rows standing at zero, keeping any ancestor of a row that survives.
 *
 * The ancestor rule is not politeness about indentation: hiding a parent whose child is
 * shown would leave the child dangling under the wrong heading. Testing the parent's own
 * `subtotal` instead would get this wrong in the one case that matters — a subtree
 * containing +100 and -100 has a zero subtotal and two rows a reader wants to see.
 */
export function pruneZeroRows<Row extends HierarchyRow>(
  lines: readonly TreeLine<Row>[],
  isZero: (row: Row) => boolean,
): readonly TreeLine<Row>[] {
  const parentOf = new Map<string, string | null>(
    lines.map((line) => [line.row.accountId, line.row.parentAccountId]),
  );

  const kept = new Set<string>();
  for (const line of lines) {
    if (isZero(line.row)) continue;
    let id: string | null = line.row.accountId;
    while (id !== null && !kept.has(id)) {
      kept.add(id);
      id = parentOf.get(id) ?? null;
    }
  }

  return lines.filter((line) => kept.has(line.row.accountId));
}
