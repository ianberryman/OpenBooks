import type { output as InferOutput, ZodType } from 'zod';
import type { OperationContext } from './context';
import type { PermissionKey } from './permissions';

export const TOOL_EXECUTION_MODES = ['execute', 'propose'] as const;

export type ToolExecutionMode = (typeof TOOL_EXECUTION_MODES)[number];

export interface McpToolContext extends OperationContext {
  readonly mode: ToolExecutionMode;
}

/**
 * What the tool would do, in the reader's terms. Spec §6 wants a person able to
 * approve or reject on the strength of this alone, so it describes consequences
 * rather than the calls that would produce them.
 */
export interface ToolProposal {
  readonly summary: string;
  readonly effects: readonly string[];
}

export type McpToolOutcome<TResult> =
  | { readonly kind: 'executed'; readonly result: TResult }
  | { readonly kind: 'proposed'; readonly proposal: ToolProposal };

/**
 * How a module contributes an MCP tool.
 *
 * A tool is a second transport over the same service as the REST route, never a
 * parallel implementation (spec §2.4) — which is why the handler takes the same
 * validated-input-plus-context pair a route handler does.
 */
export interface McpToolDefinition<TInput extends ZodType = ZodType, TResult = unknown> {
  /**
   * Spec §8: the tool name is the contract. An agent that learned a name has no
   * way to discover it changed, so a rename is a new tool plus a deprecation of
   * the old one, never an edit to this field.
   */
  readonly name: string;
  readonly description: string;
  readonly inputSchema: TInput;
  /**
   * Plain language, addressed to whoever is deciding whether to allow the call,
   * and explicit about what cannot be undone (spec §6). "Posts a journal to the
   * ledger. Posted journals cannot be edited or deleted; a mistake is corrected
   * by posting a reversal, and both entries stay visible." — not "writes to the
   * ledger".
   */
  readonly sideEffects: string;
  /** Spec §6: a human confirms before the effect lands, not after. */
  readonly requiresConfirm: boolean;
  /**
   * When false, the tool must reject `mode: 'propose'` rather than execute.
   * Silently performing something the caller asked to preview is the exact
   * failure spec §6 exists to prevent, and it is worse than an error.
   */
  readonly supportsProposeOnly: boolean;
  /** The same catalog the REST surface uses — authorization is not per-transport (spec §5). */
  readonly permission: PermissionKey;
  /** Method syntax for the same bivariance reason as `RouteDefinition.handler`. */
  handler(input: InferOutput<TInput>, ctx: McpToolContext): Promise<McpToolOutcome<TResult>>;
}
