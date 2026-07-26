# @openbooks/plugin-api

The internal module contract (spec §8). Every OpenBooks module is written against this package and
nothing else in the tree; the package itself depends on no other workspace package, which
`dependency-cruiser`'s `plugin-api-is-a-leaf` rule enforces.

**Types and interfaces only.** The only runtime values here are frozen literal tuples, two type
guards, and one service token. Anything with behaviour belongs in the module that implements the
contract — the ledger kernel implements `PostingService` (OB-020); everything else consumes it.

## Stability

`0.x`, private, unpublished, and expected to churn. Spec §8's own conclusion is that this surface
cannot stabilise until four to six modules have stressed it. M1 has one, so the shapes here encode
one module's needs and will be wrong in ways only M2 (chart of accounts, contacts, dimensions) and
M3 (subledgers, payment application) reveal. Do not defend the first design.

Two things are nonetheless treated as already-binding, because breaking them is not recoverable:

- **Event payload types carry their version in the name** (`journal.posted.v1`). Changes are
  additive — a new event joins `OpenBooksEvent`, and a semantic change to an existing payload becomes
  a `.v2` published alongside the `.v1` until subscribers migrate.
- **An MCP tool's name is its contract.** An agent that learned a name cannot discover it changed, so
  a rename is a new tool plus a deprecation.

## Layout

| File             | Contents                                                                 |
| ---------------- | ------------------------------------------------------------------------ |
| `primitives.ts`  | `MinorUnits`, `CalendarDate`, `Instant`                                  |
| `actor.ts`       | `ActorType`, `InvocationMode`, `ActorProvenance` (spec §6)               |
| `context.ts`     | `OperationContext` — what an operation knows about its caller            |
| `posting.ts`     | `PostJournalInput`, `PostedJournal`, `PostingService`, `POSTING_SERVICE` |
| `events.ts`      | `EventBus`, `OpenBooksEvent`, versioned payload types                    |
| `registry.ts`    | `ServiceToken`, `ServiceRegistry`                                        |
| `migrations.ts`  | `ModuleMigration`                                                        |
| `permissions.ts` | `PermissionKey`, `PermissionDefinition`                                  |
| `routes.ts`      | `RouteDefinition` — transport-agnostic REST contribution                 |
| `mcp.ts`         | `McpToolDefinition`, propose-only and confirmation metadata              |
| `providers.ts`   | `QueueProvider`, `StorageProvider`, `SecretsProvider`, `EmailProvider`   |
| `module.ts`      | `ModuleDefinition`, `ModuleHost`, `EventSubscription`                    |

## Two conventions worth knowing before reading the source

**Org scope never appears in an input type.** It arrives on `OperationContext` only. That is the
contract's half of Phase 0's "a query without org scope is impossible to construct" — if no input
shape carries an org, a caller cannot ask for a different org's data. OB-013 enforces the other half
at the query builder.

**Handlers are declared with method syntax, not function properties.** Method parameters are compared
bivariantly, which is what lets a module hold concretely-typed routes and tools in a
`readonly RouteDefinition[]`. The host validates input against the declared schema before calling, so
the erasure is not a hole in practice.
