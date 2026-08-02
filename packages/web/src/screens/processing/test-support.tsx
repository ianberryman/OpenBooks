import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';

/**
 * The harness this screen's tests share — `recurring-invoices/test-support.tsx`, copied
 * rather than imported for the self-containment reason `queries.ts`'
 * `useProcessingReferenceData` gives: no screen folder imports another's, so each carries
 * its own small copy of the harness that reaches it.
 *
 * ## What is stubbed, and what deliberately is not
 *
 * The API is stubbed at `fetch` and nowhere higher. Everything above it is the real thing:
 * the generated client and its middleware — which is what makes a write with no
 * `Idempotency-Key` a thrown `MissingIdempotencyKeyError` here rather than a 400 in
 * production — `unwrap`, `ApiError`, `presentApiError`, and TanStack Query. A test that
 * mocked the screen's own modules would prove only that the mocks agree with each other.
 *
 * ## Why the globals are replaced at import time, and why a test file must `await import`
 * ## the component
 *
 * `openapi-fetch` captures `globalThis.Request` and `globalThis.fetch` **once**, inside
 * `createClient` — and `src/api/client.ts` calls `createClient` during module evaluation,
 * because the client is a module singleton. A `vi.stubGlobal` in a `beforeEach` therefore
 * replaces globals nothing will ever read again. So the replacement happens here, at the
 * top level of a module that pulls in nothing from `src/api/`, and a test file imports the
 * component it exercises with `await import(...)` *after* this module has been evaluated.
 *
 * `Request` is replaced because `API_BASE_URL` is empty in this package's default
 * (same-origin) configuration, so the client builds `new Request('/v1/processing/connections')`,
 * and undici's `Request` — unlike a browser's — refuses a relative URL rather than
 * resolving it against the document. The shim resolves it against `location.href` and
 * changes nothing else.
 */

export interface StubCall {
  readonly method: string;
  readonly path: string;
  /** The raw querystring, e.g. `?type=asset&limit=200` — `''` when there was none. */
  readonly query: string;
  readonly idempotencyKey: string | null;
  readonly body: unknown;
}

export interface StubRequest {
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  readonly body: unknown;
}

export interface StubReply {
  readonly status: number;
  readonly body?: unknown;
}

export interface StubRoute {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** `/v1/processing/connections/:connectionId` — the shape the server declares its own
   *  routes with. */
  readonly path: string;
  readonly reply: (request: StubRequest) => StubReply;
}

export interface ApiStub {
  readonly calls: readonly StubCall[];
  /** Every write's key, so a test can assert one per intent rather than one per attempt. */
  keysFor(method: string, path: string): readonly string[];
}

let currentRoutes: readonly StubRoute[] = [];
let currentCalls: StubCall[] = [];

const NativeRequest = globalThis.Request;

class DocumentRelativeRequest extends NativeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(typeof input === 'string' ? new URL(input, globalThis.location.href) : input, init);
  }
}

/** An error envelope in exactly the shape every non-2xx on this API carries. */
export function apiError(
  code: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): unknown {
  return { error: { code, message, ...(details === undefined ? {} : { details }) } };
}

function matchPath(pattern: string, actual: string): Readonly<Record<string, string>> | null {
  const patternParts = pattern.split('/');
  const actualParts = actual.split('/');
  if (patternParts.length !== actualParts.length) return null;

  const params: Record<string, string> = {};
  for (const [index, part] of patternParts.entries()) {
    const value = actualParts[index];
    if (value === undefined) return null;
    if (part.startsWith(':')) params[part.slice(1)] = value;
    else if (part !== value) return null;
  }
  return params;
}

async function dispatch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = input instanceof NativeRequest ? input : new DocumentRelativeRequest(input, init);
  const url = new URL(request.url);
  const rawBody = request.method === 'GET' ? '' : await request.clone().text();
  const body: unknown = rawBody === '' ? undefined : JSON.parse(rawBody);

  currentCalls.push({
    method: request.method,
    path: url.pathname,
    query: url.search,
    idempotencyKey: request.headers.get('idempotency-key'),
    body,
  });

  for (const route of currentRoutes) {
    if (route.method !== request.method) continue;
    const params = matchPath(route.path, url.pathname);
    if (params === null) continue;

    const reply = route.reply({ params, query: url.searchParams, body });
    if (reply.status === 204) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(reply.body ?? null), {
      status: reply.status,
      headers: { 'content-type': 'application/json' },
    });
  }

  return new Response(
    JSON.stringify(
      apiError('internal_error', `No stub route for ${request.method} ${url.pathname}`),
    ),
    { status: 500, headers: { 'content-type': 'application/json' } },
  );
}

globalThis.Request = DocumentRelativeRequest;
globalThis.fetch = dispatch;

/**
 * Swaps in the route table for one test. Routes are matched in order, so a test can
 * prepend a refusing route to override a succeeding one.
 */
export function installApiStub(routes: readonly StubRoute[]): ApiStub {
  currentRoutes = routes;
  currentCalls = [];
  const calls = currentCalls;

  return {
    get calls() {
      return calls;
    },
    keysFor(method, path) {
      return calls
        .filter((call) => call.method === method && matchPath(path, call.path) !== null)
        .map((call) => call.idempotencyKey ?? '');
    },
  };
}

/**
 * Retries off and no cache between tests. Retries would turn a deliberate refusal into a
 * multi-second wait, and a shared cache would let one test's list satisfy the next test's
 * query before its own stub was ever consulted.
 */
export function renderWithQueryClient(ui: ReactElement): void {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });

  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}
