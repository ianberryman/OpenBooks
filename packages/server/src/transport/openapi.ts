/**
 * The OpenAPI document: how it is produced and how it is made byte-stable.
 *
 * Spec §12 publishes the document as a CI artifact on every merge and makes drift
 * a build failure. That only works if generation is a function of the source and
 * nothing else — ROADMAP names key ordering as the risk that turns the gate into a
 * flaky build rather than a guarantee. `canonicalize` below is the answer; see its
 * commentary for what was measured and why it is applied unconditionally.
 */
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { jsonSchemaTransform, jsonSchemaTransformObject } from 'fastify-type-provider-zod';

import type { JsonValue } from '../errors';
import type { App } from './types';

/**
 * OpenAPI 3.1, which selects zod v4's native `draft-2020-12` JSON Schema dialect
 * in `fastify-type-provider-zod` (it picks the target from this string).
 *
 * The alternative, 3.0.x, has no `null` type, so the library rewrites every
 * nullable union into `nullable: true` and strips keywords the 3.0 subset does not
 * allow. Those rewrites are lossy in exactly the places our schemas are
 * interesting — a nullable `userId`, a discriminated union — and the loss lands in
 * the generated client (OB-024). 3.1 is a superset of JSON Schema, so nothing has
 * to be rewritten at all.
 */
const OPENAPI_VERSION = '3.1.0';

const DOCS_ROUTE_PREFIX = '/docs';

/**
 * Registers `@fastify/swagger` and the UI.
 *
 * Must be called before any route is added: `@fastify/swagger` collects the route
 * table through an `onRoute` hook, so a route registered first is simply absent
 * from the document — and absent from the document is exactly the failure the
 * drift gate cannot detect, because the committed artifact would be regenerated
 * with the same omission.
 *
 * The UI is served unconditionally rather than gated on `nodeEnv`. The document it
 * renders is a published artifact of every build (spec §12), so the UI discloses
 * nothing the artifact does not; and a build flag would mean the hosted deployment
 * serves a route table no CI run ever exercised. Removing it from a public origin
 * is an edge/ALB rule, which is where that decision belongs.
 */
export async function registerOpenApi(app: App): Promise<void> {
  await app.register(swagger, {
    openapi: {
      openapi: OPENAPI_VERSION,
      info: {
        title: 'OpenBooks API',
        description:
          'Open-source, AI-native, modular double-entry accounting. Every capability in the ' +
          'product is reachable through this API (spec §8) — the web client is a consumer of ' +
          'it, not a privileged path.\n\n' +
          'Monetary amounts are strings of minor units (`"1999"` is 19.99 in a two-decimal ' +
          'currency), never JSON numbers. A JSON number cannot represent a cent exactly and ' +
          'any client that parses one has already lost the value.\n\n' +
          'Every write endpoint requires an `Idempotency-Key` header. Reusing a key with the ' +
          'same request replays the original outcome; reusing it with a different request is ' +
          'refused with `idempotency_key_conflict`.',
        version: '0.0.0',
        license: { name: 'AGPL-3.0-only', identifier: 'AGPL-3.0-only' },
      },
      // No `servers`: the document is generated at build time and the origin is a
      // deployment fact. A baked-in host is wrong for every deployment but one,
      // and a wrong `servers` entry is worse than none — a generated client
      // silently prefers it over the base URL its caller configured.
      tags: [{ name: 'system', description: 'Liveness and service metadata.' }],
    },
    transform: jsonSchemaTransform,
    // Lifts every schema carrying an `id` in zod's global registry into
    // `components.schemas`, so `ErrorResponse` is one named type the generated
    // client can reuse rather than an anonymous duplicate on every response.
    transformObject: jsonSchemaTransformObject,
  });

  await app.register(swaggerUi, { routePrefix: DOCS_ROUTE_PREFIX });
}

/**
 * Recursively sorts object keys. Arrays keep their order.
 *
 * ## What was measured
 *
 * Two separate questions, and they have different answers.
 *
 * *Is repeated generation stable?* Yes. Six fresh `tsx` processes over the same
 * source produced byte-identical raw documents (before this function ran), and
 * `test/transport/openapi.test.ts` asserts the repeat case. So there is no
 * hash-seed or iteration-order nondeterminism to chase — nothing here is keyed by
 * object identity.
 *
 * *Is it stable against a change that does not change the API?* **No.**
 * `@fastify/swagger` accumulates `paths` in route-registration order and does not
 * sort. Registering the same two routes in the opposite order produces different
 * raw bytes for an identical API surface — measured, and pinned by the
 * registration-order case in `test/transport/openapi.test.ts`. Without a canonical
 * form the drift gate therefore fails on a pure code move: reordering two
 * `app.get` calls, or splitting a route file, and CI reports that the published API
 * changed when it did not. That is the flaky-gate outcome ROADMAP warns about, and
 * it is not hypothetical.
 *
 * The same argument applies to `components.schemas`, whose order comes from zod
 * registry insertion order — that is, from module evaluation order, which changes
 * when an import moves.
 *
 * ## Consequences
 *
 * Sorting makes the artifact a function of the API surface rather than of the order
 * it happens to be written in, which is the property the gate needs. It also makes
 * the committed file's diffs minimal: inserting a route no longer rewrites the rest
 * of the document.
 *
 * Arrays are left alone because array order in OpenAPI and JSON Schema *is*
 * semantic — `required`, `enum`, `allOf`/`anyOf`/`oneOf`, `parameters`, `security`,
 * `tags`. Object key order never is.
 */
type JsonContainer = readonly JsonValue[] | { readonly [key: string]: JsonValue };

/**
 * A hand-written predicate because `Array.isArray` narrows a `readonly T[]` union
 * member to `any[]`, which then trips `no-unsafe-*`.
 */
function isJsonArray(value: JsonContainer): value is readonly JsonValue[] {
  return Array.isArray(value);
}

export function canonicalize(value: JsonValue): JsonValue {
  if (value === null || typeof value !== 'object') return value;
  if (isJsonArray(value)) return value.map((entry) => canonicalize(entry));

  const sorted: Record<string, JsonValue> = {};
  for (const key of Object.keys(value).sort()) {
    // `noUncheckedIndexedAccess` widens the read to `| undefined`; the key came
    // from `Object.keys`, so the entry is present.
    sorted[key] = canonicalize(value[key] as JsonValue);
  }
  return sorted;
}

/**
 * The bytes that belong in `openapi.json`.
 *
 * `await app.ready()` is required and not incidental: `@fastify/swagger` builds
 * the document from routes collected during registration, and `app.swagger()`
 * before ready returns a document missing everything registered inside a plugin.
 *
 * Two-space indentation and a trailing newline, because the file is committed and
 * compared byte-for-byte by the drift gate; `.prettierignore` lists it, so this
 * function is the only thing that decides its formatting.
 */
export async function generateOpenApiDocument(app: App): Promise<string> {
  await app.ready();
  // Through `JSON.stringify`/`parse` first, so `canonicalize` walks plain data and
  // not whatever class instances the document happens to hold.
  const document = canonicalize(JSON.parse(JSON.stringify(app.swagger())) as JsonValue);
  return `${JSON.stringify(document, null, 2)}\n`;
}
