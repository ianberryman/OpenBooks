import type { ZodType, output } from 'zod';

import type { ValidationIssue } from '../../errors';
import { ValidationError } from '../../errors';

/**
 * Zod parsing at the *service* boundary, not only at the HTTP boundary.
 *
 * Spec §12 treats agent and integrator input as untrusted, and spec §2.4 makes
 * the service layer the one place a capability is implemented. Those two together
 * mean validation cannot live in the route: OB-023's HTTP handler, M5's MCP tool,
 * and M6's workflow engine all reach the same service, and only one of them will
 * have a Fastify schema in front of it. Validating here costs a second parse on
 * the HTTP path — the route's schema will have already run — and buys the
 * guarantee that no caller can reach the database with an unvalidated payload.
 *
 * This helper wants a home outside `src/modules/accounts/` — OB-019 needs the
 * identical function for periods. It is not placed in `src/errors/` because this
 * ticket does not own that module, and copying it into the second module that
 * needs it is worse than one deliberate note here. See the OB-018 report.
 */

/**
 * Parses `value`, or throws a `ValidationError` carrying one issue per problem.
 *
 * Generic over the schema rather than over its output type, so a `strictObject`
 * carrying a `.refine()` — whose type is not a bare `ZodType<T>` — passes without
 * a cast at the call site.
 */
export function parseInput<S extends ZodType>(schema: S, value: unknown): output<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;

  throw new ValidationError('Request validation failed.', toValidationIssues(result.error.issues));
}

/** The subset of a zod issue this needs, structurally, so no zod type is restated. */
interface ParsedIssue {
  readonly code: string;
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

function toValidationIssues(issues: readonly ParsedIssue[]): readonly ValidationIssue[] {
  return issues.flatMap((issue) => {
    /**
     * `unrecognized_keys` is reported by zod with an empty `path` and the offending
     * names in a `keys` array, so passing it through unexpanded would produce an
     * issue whose path is `''` — the client is told *something* was unrecognised
     * without being told what.
     *
     * That matters more here than it looks. The one field a client is most likely
     * to send and have refused is `parentAccountId`, whose absence from the M1 API
     * is a decision (see `packages/shared-types/src/accounts/accounts.ts`), and a
     * decision the caller cannot see is indistinguishable from a bug in our
     * parser. Expanding to one issue per key puts the field name in `path`, where
     * every other validation failure puts it.
     */
    const keys = unrecognizedKeys(issue);
    if (keys !== undefined) {
      return keys.map((key) => ({ path: joinPath([...issue.path, key]), message: issue.message }));
    }

    return [{ path: joinPath(issue.path), message: issue.message }];
  });
}

function unrecognizedKeys(issue: ParsedIssue): readonly string[] | undefined {
  if (issue.code !== 'unrecognized_keys') return undefined;
  const keys = (issue as { readonly keys?: unknown }).keys;
  return Array.isArray(keys) ? keys.map(String) : undefined;
}

/**
 * Dotted, matching what `ValidationIssue.path` documents (`lines.0.amount`). Zod
 * paths are `PropertyKey[]` — array indices arrive as numbers — so every segment
 * is stringified rather than assumed to be one already.
 */
function joinPath(path: readonly PropertyKey[]): string {
  return path.map(String).join('.');
}
