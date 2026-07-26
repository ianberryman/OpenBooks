/**
 * `GET /health`.
 *
 * ## The contract this satisfies
 *
 * The image's `HEALTHCHECK` (Dockerfile) polls
 * `http://127.0.0.1:${HTTP_PORT:-3000}/health` and treats a non-2xx as a failing
 * container; `docker-compose.yml` gates the web service on it and disables it for
 * the `worker` and `migrate` roles, which have no listener. The path and the port
 * source are therefore fixed by the image, not chosen here — the Dockerfile
 * comment says so, and if either moves the other must follow.
 *
 * ## It does not touch the database, on purpose
 *
 * The consumers of this route act on failure by *replacing the container*. So a
 * probe that issues a query converts a transient database problem — a failover, a
 * momentarily exhausted pool, a slow query holding the last connection — into a
 * simultaneous restart of every API task, which removes the capacity that would
 * have served the recovery and produces a restart loop, because the replacements
 * cannot pass the probe either. The blast radius of a DB-dependent liveness check
 * is strictly larger than the fault it detects.
 *
 * ## Why that is not "reports healthy while broken"
 *
 * The database *is* checked — once, at startup, before the listener exists.
 * `startApi` in `src/entrypoints/api.ts` calls `initializeDatabase` and then
 * issues a single `SELECT 1`; a failure there exits non-zero and the container
 * never becomes healthy at all. Combined with migrations being a discrete
 * pre-deploy job that must exit zero first (A12, spec §12), a process that is
 * listening has already proved: config validated, pool constructed, database
 * reachable, schema migrated.
 *
 * So the check moved rather than disappeared — from a repeating probe, where a
 * blip is fatal, to startup, where it is fatal and should be. What this route
 * asserts is what the probe should act on: this process is listening and its HTTP
 * stack — routing, context, validation, serialization, error handling — works.
 * That is not nothing; it is exactly liveness.
 *
 * ## The gap, named
 *
 * There is no readiness signal for "listening but its database went away".
 * Detecting that belongs to alerting on the 500s the failing requests already
 * produce, not to a probe wired to a restart. If a genuine readiness endpoint is
 * wanted later it must be a *separate* path with its own, non-restarting consumer
 * (an ALB target group that drains rather than replaces); adding a dependency
 * check to this path would silently repurpose the container probe.
 */
import { errorResponseSchema, healthResponseSchema } from './schemas';
import type { App } from './types';

export function registerHealthRoute(app: App): void {
  app.get(
    '/health',
    {
      schema: {
        // Stable: it names the method on the generated client (OB-024) and the
        // operation in `openapi.json`.
        operationId: 'getHealth',
        summary: 'Liveness probe',
        description:
          'Returns 200 while the process is listening and its HTTP stack is working. ' +
          'Reports no dependency state; see the source commentary for why.',
        tags: ['system'],
        response: {
          200: healthResponseSchema,
          /**
           * `default`, not an enumerated list of statuses, and the pattern OB-023
           * should copy.
           *
           * Even a handler this trivial has failure modes reachable before it runs:
           * a malformed `Idempotency-Key` is rejected by the context hook (400),
           * and any unhandled fault is a 500. Enumerating those per route means
           * each route claims a set of statuses that the *shared* hook chain
           * decides, so every list is wrong the moment a hook is added.
           * `default` says the true thing — every non-2xx response on this API has
           * this body — in one place.
           */
          default: errorResponseSchema,
        },
      },
    },
    () => ({ status: 'ok' }) as const,
  );
}
