import type { McpToolContext, McpToolDefinition, ToolExecutionMode } from '@openbooks/plugin-api';
import { TOOL_EXECUTION_MODES } from '@openbooks/plugin-api';
import { z } from 'zod';

import { getContext } from '../../context';
import { parseInput, toWireError } from '../../errors';
// The one sanctioned reach past `services-do-not-import-transport`
// (`.dependency-cruiser.cjs`'s `mcp-host-reaches-only-the-app-type` rule): this
// file needs the Fastify instance type to register a route on it, and nothing
// else from `src/transport/`. See the file header below for why that is safe.
import type { App } from '../../transport/types';

import { mcpTools } from './tools';

/**
 * The MCP host (OB-103; ROADMAP D-59; spec §8, §12).
 *
 * ## No MCP SDK dependency — a minimal in-repo JSON-RPC host instead
 *
 * `package.json` across the workspace was checked first, per the ticket: no
 * `@modelcontextprotocol/*` package is a dependency anywhere in the tree. This
 * repo runs `enableScripts: false` and deliberately avoids network installs
 * (`CLAUDE.md`), so a new dependency is not something a ticket adds on the side —
 * it is the orchestrator's call, made deliberately, not this file's. What follows
 * is therefore a minimal JSON-RPC-2.0-over-HTTP implementation of the three
 * methods a tool-calling client needs — `initialize`, `tools/list`, `tools/call`
 * — against the `McpToolDefinition[]` registry `tools.ts` exports. It is
 * intentionally thin: the tools are the substance (spec §12), this file is
 * dispatch and error-shape translation, nothing more.
 *
 * ## Mounted in-process on the `api` role (D-59), not a fourth process
 *
 * `registerMcpServer(app)` adds `POST /mcp` to the same Fastify instance the REST
 * surface runs on — `PROCESS_ROLES` stays `api | worker | migrate`. It is exported
 * and **not called here**: OB-104 wires it into `buildApp` alongside the REST
 * routes, the same way `registerArtifactRoutes` and `registerPublicInvoiceRoutes`
 * are wired in `transport/app.ts` today. By the time a request reaches this
 * route's handler, the app's `onRequest` hooks have already run — the identity
 * resolvers (OAuth bearer, API key, session) have authenticated the caller and
 * opened the request-scoped context `getContext()` reads below, exactly as they
 * do for every `/v1` route. An MCP client authenticates as an OAuth bearer token
 * in practice (`oba_…`, OB-098), which is what gives `journal.propose` a real
 * `userId` to attribute a draft to (`drafts.service.ts`'s `requireAuthor`) —
 * `resolveOAuthIdentity` always resolves the *granting user's* identity, never a
 * bare "agent" actor with no one behind it.
 *
 * ## Why this file never calls `requirePermission`
 *
 * It would be a second enforcement point, which is precisely what spec §2.4/§5
 * forbid and what `modules/permissions/index.ts`'s own header calls out by name:
 * "a route that reached for `requirePermission`... would be a second enforcement
 * point, which is the whole thing the rule prevents." `transport/routes/index.ts`
 * makes the identical argument for why there is no `RouteDefinition` → Fastify
 * adapter that "honours" `RouteDefinition.permission` — the *service* enforces,
 * the transport dispatches. This file is the MCP analogue: `handleToolsCall`
 * below resolves a tool from the registry and calls its `handler`, and every
 * handler in `tools.ts` opens with `requirePermission(ctx, tool.permission)` as
 * its first line. The declared `permission` field on `McpToolDefinition` is
 * therefore read here only to *publish* it, in `tools/list` below, alongside
 * `sideEffects` and `requiresConfirm` — so a client (or the human behind it) can
 * decide whether to allow a call before making one (spec §6) — and never to gate
 * anything. What *is* legitimately this file's job, and is not authorization, is
 * refusing a `mode: "propose"` call against a tool that never declared
 * `supportsProposeOnly` — that is reading one piece of the tool's own declared
 * metadata to route the call, the same category of thing Fastify does when a
 * method has no matching route.
 *
 * ## The `McpToolOutcome` is the JSON-RPC result, verbatim
 *
 * A `tools/call` result here is `{ kind: 'executed', result }` or
 * `{ kind: 'proposed', proposal }` — `mcp.ts`'s own shape — rather than forced into
 * the upstream MCP spec's `content: [...]` text-block convention, which is built
 * for a chat transcript and would need this host to invent a serialization of a
 * trial balance into prose for no reader. A client speaking this host's tool
 * suite reads `outcome.kind` directly.
 */

const JSONRPC_VERSION = '2.0';

/**
 * JSON-RPC's own reserved error codes, used only for malformed envelopes this
 * host refuses before it has resolved a tool — an unparseable request, an
 * unknown method, a call naming no such tool, an unsupported `mode`. A plain
 * `as const` object rather than a TS `enum`, matching every other closed set in
 * this codebase (`PERMISSION_KEYS`, `ERROR_CODES`) — `enum` emits a runtime
 * object with reverse mappings this file never needs, and `const enum` does not
 * survive esbuild's per-file transpilation (`yarn build`).
 */
const JSON_RPC_ERROR_CODES = {
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  /**
   * The reserved "implementation-defined server error" band a tool's own
   * refusal lands in — see `toJsonRpcErrorResponse` below.
   */
  toolError: -32000,
} as const;

/** A refusal this host makes itself, before a tool's own handler ever runs. */
class JsonRpcProtocolError extends Error {
  constructor(
    readonly rpcCode: number,
    message: string,
  ) {
    super(message);
  }
}

interface JsonRpcCall {
  readonly id: string | number | null;
  readonly method: string;
  readonly params: unknown;
}

/** Structural validation of the envelope only — `method`'s meaning is `dispatch`'s job. */
function asJsonRpcCall(body: unknown): JsonRpcCall | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const record = body as Record<string, unknown>;
  if (record['jsonrpc'] !== JSONRPC_VERSION) return undefined;

  const method = record['method'];
  if (typeof method !== 'string' || method.length === 0) return undefined;

  const id = record['id'];
  if (id !== undefined && id !== null && typeof id !== 'string' && typeof id !== 'number') {
    return undefined;
  }

  return { id: id ?? null, method, params: record['params'] };
}

function isToolExecutionMode(value: unknown): value is ToolExecutionMode {
  return typeof value === 'string' && (TOOL_EXECUTION_MODES as readonly string[]).includes(value);
}

interface ToolCallRequest {
  readonly name: string;
  readonly rawInput: unknown;
  readonly mode: ToolExecutionMode;
}

/**
 * `tools/call`'s params: `{ name, arguments?, mode? }`. `mode` is this system's
 * own extension — it is what selects between `execute` and `propose` (`mcp.ts`);
 * the upstream MCP `tools/call` shape has no equivalent because no other tool
 * suite needs it. Absent means `"execute"`, the ordinary case.
 */
function asToolCallRequest(params: unknown): ToolCallRequest {
  if (typeof params !== 'object' || params === null) {
    throw new JsonRpcProtocolError(
      JSON_RPC_ERROR_CODES.invalidParams,
      'tools/call requires params.',
    );
  }

  const record = params as Record<string, unknown>;
  const name = record['name'];
  if (typeof name !== 'string' || name.length === 0) {
    throw new JsonRpcProtocolError(
      JSON_RPC_ERROR_CODES.invalidParams,
      'tools/call requires a string `name`.',
    );
  }

  const mode = record['mode'] ?? 'execute';
  if (!isToolExecutionMode(mode)) {
    throw new JsonRpcProtocolError(
      JSON_RPC_ERROR_CODES.invalidParams,
      `\`mode\` must be one of: ${TOOL_EXECUTION_MODES.join(', ')}.`,
    );
  }

  return { name, rawInput: record['arguments'], mode };
}

function handleInitialize(): unknown {
  return {
    protocolVersion: '2025-03-26',
    serverInfo: { name: 'openbooks', version: '0.1.0' },
    // No `resources` or `prompts` capability: this host implements tools only,
    // which is the whole of OB-103's scope.
    capabilities: { tools: {} },
  };
}

function handleToolsList(tools: readonly McpToolDefinition[]): unknown {
  return {
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      // Zod v4's native converter (`z.toJSONSchema`) — no `zod-to-json-schema`
      // dependency needed, matching `fastify-type-provider-zod`'s own use of the
      // same schemas for `openapi.json` (`transport/openapi.ts`).
      inputSchema: z.toJSONSchema(tool.inputSchema),
      // The rest of `mcp.ts`'s declared metadata, published for the same reason
      // the input schema is: a client — or the human behind it — deciding whether
      // to allow a call needs to know what permission it needs, what it does, and
      // whether it can be previewed rather than executed (spec §6).
      permission: tool.permission,
      sideEffects: tool.sideEffects,
      requiresConfirm: tool.requiresConfirm,
      supportsProposeOnly: tool.supportsProposeOnly,
    })),
  };
}

async function handleToolsCall(
  registry: ReadonlyMap<string, McpToolDefinition>,
  params: unknown,
): Promise<unknown> {
  const { name, rawInput, mode } = asToolCallRequest(params);

  const tool = registry.get(name);
  if (tool === undefined) {
    throw new JsonRpcProtocolError(JSON_RPC_ERROR_CODES.invalidParams, `No such tool: ${name}.`);
  }

  // Declared-metadata dispatch, not authorization (see the file header): a tool
  // that never claimed `supportsProposeOnly` has no preview to offer, so a
  // `propose` call against it is refused here rather than reaching a handler that
  // would have to refuse it itself, six times over.
  if (mode === 'propose' && !tool.supportsProposeOnly) {
    throw new JsonRpcProtocolError(
      JSON_RPC_ERROR_CODES.invalidParams,
      `${name} does not support mode: "propose" — it has no preview to offer. Call it with ` +
        'mode: "execute".',
    );
  }

  // Parsed here, once, the same way a REST body is parsed by Fastify's compiled
  // validator before a route handler ever runs (`transport/app.ts`). Every
  // service this tool suite calls re-parses regardless (`src/errors/parse.ts`'s
  // header: "validation cannot live in the route... only one of them will have a
  // Fastify schema in front of it"), so this parse is the MCP transport's half of
  // that same double-check, not a second source of truth for what is valid.
  const input = parseInput(tool.inputSchema, rawInput ?? {});

  const ctx: McpToolContext = { ...getContext(`mcp:${name}`), mode };

  return tool.handler(input, ctx);
}

async function dispatch(
  call: JsonRpcCall,
  registry: ReadonlyMap<string, McpToolDefinition>,
  tools: readonly McpToolDefinition[],
): Promise<unknown> {
  switch (call.method) {
    case 'initialize':
      return handleInitialize();
    case 'tools/list':
      return handleToolsList(tools);
    case 'tools/call':
      return handleToolsCall(registry, call.params);
    default:
      throw new JsonRpcProtocolError(
        JSON_RPC_ERROR_CODES.methodNotFound,
        `No such method: ${call.method}.`,
      );
  }
}

interface JsonRpcErrorResponse {
  readonly status: number;
  readonly body: {
    readonly jsonrpc: typeof JSONRPC_VERSION;
    readonly id: string | number | null;
    readonly error: { readonly code: number; readonly message: string; readonly data?: unknown };
  };
}

/**
 * `error` thrown by `dispatch`, turned into a JSON-RPC error envelope.
 *
 * A `JsonRpcProtocolError` (malformed envelope, unknown method, unknown tool,
 * unsupported mode) is this host's own refusal and carries its reserved code
 * verbatim. Everything else — every `OpenBooksError` a tool's handler threw, and
 * anything this host does not recognise — goes through `toWireError`, exactly the
 * function the REST error handler uses (`transport/errors.ts`), so an MCP caller
 * and an HTTP caller see the same `code`/`message`/`details` for the same failure
 * (F5). It travels as `data` on a fixed `-32000` "server error": the JSON-RPC
 * top-level `code` only says "the call was refused or failed", and `data.code` —
 * `permission_denied`, `not_found`, `validation_failed` — is what a client
 * actually branches on, the same field an HTTP client reads from the response
 * body.
 *
 * Pure: it maps, it does not log. Logging belongs to the route handler, which has
 * the request-scoped `request.log` — the global `getLogger()` is wrong here for two
 * reasons, one of which is a live bug: it lacks this request's actor provenance, and
 * it lazily calls `getConfig()`, which throws in any process that authenticated a
 * caller without loading the global config first (every `buildTestApp` harness),
 * turning a clean 403/400 into a masked 500.
 */
function toJsonRpcErrorResponse(id: string | number | null, error: unknown): JsonRpcErrorResponse {
  if (error instanceof JsonRpcProtocolError) {
    return {
      status: 400,
      body: {
        jsonrpc: JSONRPC_VERSION,
        id,
        error: { code: error.rpcCode, message: error.message },
      },
    };
  }

  const wire = toWireError(error);
  return {
    status: wire.status,
    body: {
      jsonrpc: JSONRPC_VERSION,
      id,
      error: { code: JSON_RPC_ERROR_CODES.toolError, message: wire.message, data: wire },
    },
  };
}

export interface RegisterMcpServerDeps {
  /** Overrides the published tool suite. Tests use this; production never does. */
  readonly tools?: readonly McpToolDefinition[];
}

/**
 * Mounts `POST /mcp` on `app`. Exported and never called here — OB-104 wires it
 * into `transport/app.ts` alongside the REST routes (see the file header).
 */
export function registerMcpServer(app: App, deps: RegisterMcpServerDeps = {}): void {
  const tools = deps.tools ?? mcpTools;
  const registry = new Map(tools.map((tool) => [tool.name, tool] as const));

  // `{ hide: true }` keeps this out of `openapi.json`, matching every other
  // non-REST endpoint on this app (`registerArtifactRoutes`): the MCP surface is
  // documented by `tools/list`, not by the REST artifact.
  app.post('/mcp', { schema: { hide: true } }, async (request, reply) => {
    const call = asJsonRpcCall(request.body);
    if (call === undefined) {
      return reply.status(400).send({
        jsonrpc: JSONRPC_VERSION,
        id: null,
        error: { code: JSON_RPC_ERROR_CODES.invalidRequest, message: 'Invalid Request' },
      });
    }

    try {
      const result = await dispatch(call, registry, tools);
      return { jsonrpc: JSONRPC_VERSION, id: call.id, result };
    } catch (error) {
      const { status, body } = toJsonRpcErrorResponse(call.id, error);
      // Split on status the way `transport/errors.ts` does: a 5xx is ours to fix, a
      // 4xx is the caller's. `request.log` carries this request's actor provenance.
      if (status >= 500) request.log.error({ err: error }, 'mcp: tool call failed');
      else request.log.warn({ err: error }, 'mcp: tool call rejected');
      return reply.status(status).send(body);
    }
  });
}
