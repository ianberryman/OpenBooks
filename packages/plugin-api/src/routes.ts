import type { output as InferOutput, ZodType } from 'zod';
import type { OperationContext } from './context';
import type { PermissionKey } from './permissions';

export const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

/**
 * How a module contributes REST surface.
 *
 * Nothing here is Fastify-shaped, and that is the point: `handler` receives an
 * already-validated input object and an `OperationContext`, which is exactly what
 * an MCP tool or the M6 workflow engine can also supply. Spec §2.4 wants one
 * service layer behind many transports, and the moment a handler signature
 * mentions a request or a reply the second transport has to fake one.
 *
 * Handlers hold no authorization logic either — `permission` is declarative so
 * the host enforces it identically for every transport (spec §5).
 */
export interface RouteDefinition<
  TInput extends ZodType = ZodType,
  TOutput extends ZodType = ZodType,
> {
  readonly method: HttpMethod;
  /** `:param` segments are merged into the input object by the HTTP adapter. */
  readonly path: `/${string}`;
  /** Stable: it names the method on the generated client (OB-024) and in the OpenAPI spec. */
  readonly operationId: string;
  readonly summary: string;
  /** Null only for the routes that establish identity — register, login. */
  readonly permission: PermissionKey | null;
  /** Spec §12: every write endpoint, not only posting, requires an `Idempotency-Key`. */
  readonly requiresIdempotencyKey: boolean;
  /**
   * One schema for the whole operation rather than Fastify's params/query/body
   * triple. Splitting the input by HTTP location puts transport structure inside
   * the handler and makes the same handler unreachable from MCP.
   */
  readonly input: TInput;
  /** Also the response schema in the emitted OpenAPI artifact (OB-022). */
  readonly output: TOutput;
  /**
   * Declared as a method rather than a function property on purpose: method
   * parameters are compared bivariantly, which is what lets a module hold
   * concretely-typed routes in a `readonly RouteDefinition[]`. The erasure is not
   * a hole in practice because the host validates against `input` before calling.
   */
  handler(input: InferOutput<TInput>, ctx: OperationContext): Promise<InferOutput<TOutput>>;
}
