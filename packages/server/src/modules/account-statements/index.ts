/**
 * Customer statement of account (OB-220 part 1).
 *
 * An open-item AR statement for one contact — `getAging` (OB-065) with
 * `contactId` and `detail` set, rendered to a branded PDF, stored behind the
 * `StorageProvider`, and recorded in `customer_statements` so it is
 * re-downloadable and, when requested, emailed with a hosted capability-token
 * link. Mirrors `modules/statements` (statement packages) and `modules/delivery`
 * (invoice delivery), folded into one module here because a customer statement is
 * simultaneously "a rendered report artifact" and "a thing that can be emailed" —
 * the two halves those two sibling modules keep apart.
 *
 * ## Surface
 *
 * | Operation                                | Callers                                          |
 * | ------------------------------------------ | --------------------------------------------------- |
 * | `createCustomerStatement(input, ctx)`    | `transport/routes/customer-statements.ts`        |
 * | `listCustomerStatements(contactId, ctx)` | `transport/routes/customer-statements.ts`        |
 * | `getPublicStatementArtifact(token)`      | `transport/routes/public-statements.ts`          |
 *
 * There is no route for `mintStatementToken`/`verifyStatementToken` themselves —
 * minting is `createCustomerStatement`'s, at the moment a delivery is requested,
 * and verifying is `getPublicStatementArtifact`'s own first step. See `token.ts`'s
 * header for why minting is reused from `modules/delivery` verbatim while
 * verifying is not.
 */
export { createCustomerStatement, listCustomerStatements } from './account-statement.service';

export { getPublicStatementArtifact } from './public-statement.service';
export type { PublicStatementArtifact } from './public-statement.service';

export { mintStatementToken, verifyStatementToken } from './token';
export type { MintedStatementToken, StatementTokenMatch } from './token';
