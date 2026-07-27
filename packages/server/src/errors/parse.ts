import type { ZodType, output } from 'zod';

import type { ValidationIssue } from './errors';
import { ValidationError } from './errors';

/**
 * Zod parsing at the *service* boundary, not only at the HTTP boundary.
 *
 * Spec §12 treats agent and integrator input as untrusted, and spec §2.4 makes the
 * service layer the one place a capability is implemented. Those two together mean
 * validation cannot live in the route: the HTTP handler, M5's MCP tool, and M6's
 * workflow engine all reach the same service, and only one of them will have a
 * Fastify schema in front of it. Validating here costs a second parse on the HTTP
 * path — the route's schema will have already run — and buys the guarantee that no
 * caller can reach the database with an unvalidated payload.
 *
 * ## Why this lives in `src/errors/` rather than in a module
 *
 * It was written for OB-018 with a note saying it wanted a home outside
 * `modules/accounts/`, and the note asked to be acted on rather than copied. By the
 * end of M2 wave 2 it had been copied four times — accounts, contacts, dimensions,
 * members — with a fifth variant in `periods`, and three separate reports flagged it
 * independently.
 *
 * `src/errors/` is the right home and not merely a convenient one: this function's
 * entire contract is *which error it throws and what that error's issues look like*.
 * The alternative homes are worse for a reason each. A shared `modules/common/` would
 * be a module every module imports, which is a package pretending to be a directory.
 * Importing from a sibling — `contacts` reaching into `accounts/input` — would put an
 * edge in the dependency graph asserting that contacts are built on the chart of
 * accounts, which dependency-cruiser would then be enforcing as though it meant
 * something.
 */

/**
 * Parses `value`, or throws a `ValidationError` carrying one issue per problem.
 *
 * Generic over the schema rather than over its output type, so a `strictObject`
 * carrying a `.refine()` — whose type is not a bare `ZodType<T>` — passes without a
 * cast at the call site.
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
     * That matters more than it looks, because the fields most likely to be sent and
     * refused are the ones whose absence is a decision rather than an oversight:
     * `code` on an account update (D-27), `parentAccountId` before OB-035 gave it
     * rules. A decision the caller cannot see is indistinguishable from a bug in our
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
 * paths are `PropertyKey[]` — array indices arrive as numbers — so every segment is
 * stringified rather than assumed to be one already.
 */
function joinPath(path: readonly PropertyKey[]): string {
  return path.map(String).join('.');
}
