import { z } from 'zod';

/**
 * The list envelope and the page cursor, shared by every list endpoint (D-21).
 *
 * ## Why there is one envelope and not one per resource
 *
 * Six M2 tickets add a list — contacts, dimensions, drafts, members, the journal
 * list, the general ledger — and each of them would otherwise invent its own key
 * name, its own "is there more" signal, and its own cursor format. The generated
 * client (OB-024) would then carry six unrelated types for one idea, and a caller
 * that learned to page one collection would have to learn it again for the next.
 * So the items live under `items` rather than under `accounts` or `journals`: a
 * resource-named key reads marginally better at one call site and costs a shared
 * type at every other.
 *
 * ## Why the cursor is encoded
 *
 * A cursor is a position in an ordering, and this API's orderings are
 * `(entry_date, sequence_number)` for journals and the general ledger and
 * `(created_at, id)` elsewhere (D-21). A cursor a client can read is a cursor a
 * client will parse, and from that moment the ordering columns are part of the
 * public contract — adding a tiebreaker or changing a sort becomes a breaking
 * change nobody agreed to. Encoding makes the tuple private to the server, which
 * is the only reason a later ticket can change it.
 *
 * Base64url of the server's own encoding, and deliberately **not** signed or
 * encrypted: a forged cursor names a position in the caller's own org's list, and
 * the query is org-scoped by `tenantDb` regardless of what the cursor says, so
 * there is nothing here for a signature to protect. What the server must do
 * instead is *refuse* a cursor it cannot decode — silently starting from the
 * beginning would turn a client's paging loop into an infinite one.
 *
 * What this commits us to, stated plainly because it is the part that is hard to
 * undo: the cursor is an opaque token that a client stores and sends back
 * verbatim, it is not stable across deployments that change an ordering, and it is
 * not a bookmark to persist. It is valid for the next page of the request that
 * produced it.
 */

/**
 * The page size when the caller does not ask for one.
 *
 * Fifty rows is a screenful and a half — enough that the common case is one
 * request, small enough that the first page renders before a user decides the
 * thing is slow.
 */
export const PAGE_SIZE_DEFAULT = 50;

/**
 * The largest page any endpoint will return, whatever the caller asks for.
 *
 * Two hundred, chosen against the widest list this API has rather than as a round
 * number: a journal summary is a few hundred bytes, so a full page is tens of
 * kilobytes — a response an ordinary client renders in one pass. It is also above
 * the size of a typical small-business chart of accounts, so the screen that most
 * wants to avoid paging usually does.
 *
 * The bound exists at all because "return everything" is what `listAccounts` did
 * before this, and an unbounded list is a request whose cost is set by the
 * caller's data rather than by the caller. Over the bound is a
 * `validation_failed`, not a silent clamp: a client that asked for 1,000 rows and
 * received 200 with no `nextCursor` would have no way to tell a truncated answer
 * from a complete one.
 */
export const PAGE_SIZE_MAX = 200;

/**
 * A bound on the encoded cursor, so a malformed one is refused before it is
 * decoded rather than after. Generous against the longest tuple in use — two
 * columns, base64url of a short JSON array — because the cost of being wrong in
 * the tight direction is an endpoint that cannot page its own data.
 */
export const PAGE_CURSOR_MAX_LENGTH = 512;

export const pageCursorSchema = z
  .string()
  .min(1)
  .max(PAGE_CURSOR_MAX_LENGTH)
  .meta({
    id: 'PageCursor',
    description:
      'An opaque position in a list. Send back the `nextCursor` of the previous page verbatim to ' +
      'get the next one. Do not parse it, construct it, or store it: its contents are the ' +
      'server’s ordering columns and they are free to change.',
  });

export const pageLimitSchema = z
  .int()
  .min(1)
  .max(PAGE_SIZE_MAX)
  .meta({
    description:
      'How many items to return, at most. Over the maximum is refused rather than clamped, so a ' +
      'short page always means the list is short.',
  });

/**
 * The pagination half of a list query, spread into each endpoint's own query
 * schema alongside its filters.
 *
 * These bounds are a *restatement*, in the sense `MINOR_UNITS_WIRE_PATTERN` uses:
 * the authority is `resolvePageLimit` and the cursor decoder in
 * `packages/server/src/db/keyset.ts`, because the HTTP route is not the only
 * caller (spec §12) and an MCP tool reaching the same service has no Zod schema in
 * front of it. Declaring them here is what puts the numbers in `openapi.json`.
 */
export const pageQueryShape = {
  limit: pageLimitSchema.default(PAGE_SIZE_DEFAULT),
  cursor: pageCursorSchema.optional(),
};

/**
 * Builds the response schema for one paginated collection.
 *
 * A factory rather than a generic `Page<T>` component, because OpenAPI 3.1 has no
 * generics: each collection needs its own named component or the generated client
 * types every list as `unknown[]`. The `id` therefore comes from the call site —
 * `AccountPage`, `JournalPage` — and the shape comes from here, which is the split
 * that keeps six endpoints identical.
 *
 * `nextCursor` is `null` and not absent when the list is exhausted, matching the
 * convention every response schema here follows: a field that is sometimes missing
 * and sometimes present is two shapes, and under `exactOptionalPropertyTypes` they
 * are two types.
 */
export function pageSchema<Item extends z.ZodType>(
  item: Item,
  meta: { readonly id: string; readonly description: string },
) {
  return z
    .strictObject({
      items: z.array(item),
      nextCursor: pageCursorSchema.nullable().meta({
        description:
          'The cursor for the next page, or `null` when this is the last one. Presence is the ' +
          'only signal that more exists — a full page does not imply another, and a short page ' +
          'never means a truncated answer.',
      }),
    })
    .meta(meta);
}
