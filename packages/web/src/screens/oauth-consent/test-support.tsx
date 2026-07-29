import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';

/**
 * The harness this screen's tests share — `recurring-invoices/test-support.tsx`, copied
 * for the self-containment reason `queries.ts` gives elsewhere in this package: no screen
 * folder imports another's. See that module for why the API is stubbed at `fetch` and
 * nowhere higher, and why the globals are replaced at import time rather than in a
 * `beforeEach`.
 */

export interface StubCall {
  readonly method: string;
  readonly path: string;
  readonly query: string;
}

export interface StubRequest {
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
}

export interface StubReply {
  readonly status: number;
  readonly body?: unknown;
}

export interface StubRoute {
  readonly method: 'GET';
  readonly path: string;
  readonly reply: (request: StubRequest) => StubReply;
}

let currentRoutes: readonly StubRoute[] = [];
let currentCalls: StubCall[] = [];

const NativeRequest = globalThis.Request;

class DocumentRelativeRequest extends NativeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(typeof input === 'string' ? new URL(input, globalThis.location.href) : input, init);
  }
}

function apiError(code: string, message: string): unknown {
  return { error: { code, message } };
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

// Not `async`: the stub resolves routes synchronously and returns a resolved promise,
// which is all `fetch`'s signature requires — an `async` with no `await` is a lint error.
function dispatch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = input instanceof NativeRequest ? input : new DocumentRelativeRequest(input, init);
  const url = new URL(request.url);

  currentCalls.push({ method: request.method, path: url.pathname, query: url.search });

  for (const route of currentRoutes) {
    if (route.method !== request.method) continue;
    const params = matchPath(route.path, url.pathname);
    if (params === null) continue;

    const reply = route.reply({ params, query: url.searchParams });
    return Promise.resolve(
      new Response(JSON.stringify(reply.body ?? null), {
        status: reply.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }

  return Promise.resolve(
    new Response(
      JSON.stringify(
        apiError('internal_error', `No stub route for ${request.method} ${url.pathname}`),
      ),
      { status: 500, headers: { 'content-type': 'application/json' } },
    ),
  );
}

globalThis.Request = DocumentRelativeRequest;
globalThis.fetch = dispatch;

export function installApiStub(routes: readonly StubRoute[]): {
  readonly calls: readonly StubCall[];
} {
  currentRoutes = routes;
  currentCalls = [];
  const calls = currentCalls;

  return {
    get calls() {
      return calls;
    },
  };
}

export function renderWithQueryClient(ui: ReactElement): void {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });

  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}
