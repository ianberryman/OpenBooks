import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { App } from '../../src/transport/index';
import { canonicalize, generateOpenApiDocument } from '../../src/transport/index';
import { buildTestApp } from './harness';

/** Same path `src/entrypoints/spec.ts` writes. */
const ARTIFACT_PATH = fileURLToPath(new URL('../../../../openapi.json', import.meta.url));

const open: App[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((app) => app.close()));
});

async function build(): Promise<App> {
  const { app } = await buildTestApp();
  open.push(app);
  return app;
}

/** The document, as the spec entrypoint produces it. */
async function document(): Promise<Record<string, unknown>> {
  return JSON.parse(await generateOpenApiDocument(await build())) as Record<string, unknown>;
}

describe('the OpenAPI document', () => {
  it('is a well-formed OpenAPI 3.1 document', async () => {
    const doc = await document();

    expect(doc['openapi']).toBe('3.1.0');
    expect(doc['info']).toMatchObject({ title: expect.any(String), version: expect.any(String) });
    expect(doc['paths']).toBeTypeOf('object');

    const paths = doc['paths'] as Record<string, Record<string, unknown>>;
    expect(Object.keys(paths).length).toBeGreaterThan(0);

    const operationIds: string[] = [];
    for (const [path, item] of Object.entries(paths)) {
      expect(path.startsWith('/'), `path ${path} must be absolute`).toBe(true);

      for (const [method, operation] of Object.entries(item)) {
        expect(['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace']).toContain(
          method,
        );
        const op = operation as Record<string, unknown>;
        // Stable operationIds are what name the methods on the generated client
        // (OB-024); a duplicate silently overwrites one of them.
        expect(op['operationId'], `${method} ${path} needs an operationId`).toBeTypeOf('string');
        expect(op['summary'], `${method} ${path} needs a summary`).toBeTypeOf('string');
        expect(op['responses'], `${method} ${path} needs responses`).toBeTypeOf('object');
        operationIds.push(op['operationId'] as string);
      }
    }

    expect(new Set(operationIds).size).toBe(operationIds.length);
  });

  it('resolves every $ref against components.schemas', async () => {
    const doc = await document();
    const schemas = (doc['components'] as { schemas?: Record<string, unknown> } | undefined)
      ?.schemas;

    const refs: string[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const entry of value) walk(entry);
        return;
      }
      if (value === null || typeof value !== 'object') return;
      for (const [key, nested] of Object.entries(value)) {
        if (key === '$ref' && typeof nested === 'string') refs.push(nested);
        else walk(nested);
      }
    };
    walk(doc);

    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref.startsWith('#/components/schemas/'), `unexpected ref form ${ref}`).toBe(true);
      expect(schemas?.[ref.slice('#/components/schemas/'.length)]).toBeDefined();
    }
  });

  it('documents GET /health', async () => {
    const doc = await document();
    const paths = doc['paths'] as Record<string, Record<string, unknown>>;

    expect(paths['/health']).toBeDefined();
    expect(paths['/health']?.['get']).toMatchObject({
      operationId: 'getHealth',
      tags: ['system'],
    });
  });

  /**
   * `/docs` and its assets are the swagger-ui plugin's own routes. They exist to
   * render the document and are not part of the API surface, so they must not
   * appear in it — `fastify-type-provider-zod`'s default skip list is what keeps
   * them out, and this asserts it still does.
   */
  it('excludes the documentation UI routes', async () => {
    const doc = await document();
    const paths = Object.keys(doc['paths'] as Record<string, unknown>);

    expect(paths.filter((path) => path.startsWith('/docs'))).toEqual([]);
  });
});

/**
 * A10 — spec drift is a build failure, which is only a guarantee if generation is a
 * function of the source. ROADMAP names key ordering as the risk that would turn
 * the gate into a flaky build.
 */
describe('determinism', () => {
  it('produces identical bytes on repeated generation', async () => {
    const first = await generateOpenApiDocument(await build());
    const second = await generateOpenApiDocument(await build());
    const third = await generateOpenApiDocument(await build());

    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  /**
   * The measured claim behind `canonicalize`.
   *
   * Registering the same two routes in the opposite order changes the raw
   * document's `paths` key order — so the raw generator *is* order-sensitive, and
   * "it happens to be stable today" is only true while nobody moves a route
   * registration. Canonicalizing makes the artifact a function of the route set
   * rather than of the order the routes were written in, which is what the drift
   * gate needs.
   */
  it('is insensitive to route registration order once canonicalized', async () => {
    const schema = {
      summary: 'test',
      response: { 200: z.object({ ok: z.literal(true) }) },
    } as const;
    const alpha = () => ({ ok: true }) as const;

    const forwards = await build();
    forwards.get('/t/aaa', { schema }, alpha);
    forwards.get('/t/zzz', { schema }, alpha);

    const backwards = await build();
    backwards.get('/t/zzz', { schema }, alpha);
    backwards.get('/t/aaa', { schema }, alpha);

    await forwards.ready();
    await backwards.ready();

    const rawForwards = JSON.stringify(forwards.swagger());
    const rawBackwards = JSON.stringify(backwards.swagger());
    expect(rawBackwards).not.toBe(rawForwards);

    expect(JSON.stringify(canonicalize(JSON.parse(rawBackwards)))).toBe(
      JSON.stringify(canonicalize(JSON.parse(rawForwards))),
    );
  });

  it('sorts object keys at every depth and leaves arrays alone', () => {
    const canonical = canonicalize({
      z: 1,
      a: { d: [3, 1, 2], c: { b: true, a: false } },
    }) as Record<string, unknown>;

    expect(JSON.stringify(canonical)).toBe('{"a":{"c":{"a":false,"b":true},"d":[3,1,2]},"z":1}');
  });
});

/**
 * The drift gate, asserted from the test suite as well as from CI.
 *
 * `yarn spec --check` is the gate OB-027 runs; this makes a stale artifact fail
 * `yarn test` too, so it is caught before a push rather than in a pipeline.
 */
describe('the committed artifact', () => {
  it('matches what the generator produces', async () => {
    const committed = await readFile(ARTIFACT_PATH, 'utf8');

    expect(await generateOpenApiDocument(await build())).toBe(committed);
  });
});
