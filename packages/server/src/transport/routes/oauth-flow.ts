import type {
  OAuthAuthorizeQuery,
  OAuthConsentDecision,
  OAuthTokenError,
} from '@openbooks/shared-types';

import { getContext } from '../../context';
import { NotFoundError, UnauthenticatedError, ValidationError } from '../../errors';
import {
  authorizeRequest,
  exchangeToken,
  grantAuthorization,
  revokeToken,
} from '../../modules/oauth';
import type { App } from '../types';

/**
 * The OAuth 2.1 flow's own wire endpoints (OB-098, OB-104; ROADMAP D-53, D-54,
 * D-61): `GET /oauth/authorize`, `POST /oauth/consent`, `POST /oauth/token`,
 * `POST /oauth/revoke`. Mirrors `public-invoices.ts`: registered directly on
 * `app` in `transport/app.ts`, outside `registerV1Routes` and therefore outside
 * `/v1` — not a stylistic choice, but the statement that this surface carries a
 * different contract than the rest of the API. `/v1/oauth-clients` and
 * `/v1/connected-apps` (`oauth-clients.ts`) are this project's own JSON
 * management routes over the *same* service and stay inside `/v1`, exactly the
 * split `oauth.service.ts`'s header draws between its two "registers".
 *
 * ## Why every route here is `{ hide: true }` and declares no Zod schema
 *
 * `token` and `revoke` are RFC 6749 §5 / RFC 7009 wire formats: form-encoded,
 * snake_case, and their bodies are never `errorResponseSchema` —
 * `oauth.service.ts`'s header states plainly that `exchangeToken`/`revokeToken`
 * must never throw this project's envelope errors. `authorize` and `consent`
 * carry the same constraint from the browser-redirect side: `authorize` receives
 * RFC snake_case *query* parameters from a third-party client's redirect
 * (`response_type`, `client_id`, …) that this file maps onto
 * `oauthAuthorizeQuerySchema`'s camelCase fields by hand, and both `authorize`
 * and `consent` must answer an invalid client or `redirectUri` **without**
 * redirecting anywhere at all (RFC 6749 §4.1.2.1's "MUST NOT automatically
 * redirect the user-agent"), so neither can declare a `response` schema that
 * assumes every reply reaches the caller as one shape. `fastify-type-provider-zod`
 * has nothing to attach to any of that, so none of the four appears in
 * `openapi.json` — RFC 6749/7009 are this surface's documentation, the same
 * argument `registerMcpServer`'s own `{ hide: true }` makes for `tools/list`.
 *
 * ## The redirect_uri rule, enforced once and read twice
 *
 * `requireExactRedirectUri` inside `oauth.service.ts` is what refuses an
 * unregistered redirect target, and both `authorizeRequest` and
 * `grantAuthorization` call it before returning — so neither handler below ever
 * holds a `redirectUri` the service has not already validated, and
 * `toOAuthFlowError` is what a handler falls back to instead of redirecting: an
 * OAuth-shaped `{ error, error_description }` body on the status RFC 6749 names
 * for the failure.
 *
 * ## No `Idempotency-Key` on any of these four
 *
 * `authorize` and `token`/`revoke` are RFC endpoints third-party OAuth client
 * libraries call verbatim — inventing a required header no such library sends
 * would make every off-the-shelf client fail this API alone. `consent` is this
 * project's own screen and could in principle take one, but `grantAuthorization`
 * is not wired to `withIdempotency`/`withGlobalIdempotency` today (unlike
 * `login`/`register`), and a double-submitted consent mints a second, independent,
 * single-use authorization code rather than a duplicate of anything — harmless in
 * the way `login`'s double-submit is not. Left out rather than added speculatively;
 * flagged in the OB-104 report for the orchestrator to weigh.
 */

/**
 * RFC 6749 §4.1.2.1 / §5.2's error body — `{ error, error_description }` — mapped
 * from the `OpenBooksError`s `authorizeRequest`/`grantAuthorization` can throw.
 * Anything else is rethrown and falls through to the ordinary error handler
 * (`transport/errors.ts`): a genuinely unexpected failure is a `500` in this
 * project's own envelope, not a fabricated RFC shape for a case RFC never named.
 */
function toOAuthFlowError(error: unknown): {
  readonly status: 400 | 401;
  readonly body: OAuthTokenError;
} {
  if (error instanceof UnauthenticatedError) {
    return {
      status: 401,
      body: { error: 'access_denied', error_description: 'Authentication required.' },
    };
  }
  if (error instanceof NotFoundError) {
    return {
      status: 400,
      body: { error: 'unauthorized_client', error_description: error.clientMessage },
    };
  }
  if (error instanceof ValidationError) {
    return {
      status: 400,
      body: { error: 'invalid_request', error_description: error.clientMessage },
    };
  }
  throw error;
}

/**
 * Maps RFC 6749's snake_case `authorize` query onto `oauthAuthorizeQuerySchema`'s
 * camelCase fields. Not validated here — every field is read as `unknown` and
 * `authorizeRequest` re-parses with `oauthAuthorizeQuerySchema` (`parseInput`),
 * so a missing or malformed field surfaces as the same `ValidationError`
 * `toOAuthFlowError` maps below, whichever field it names.
 */
function toAuthorizeQuery(raw: Record<string, unknown>): OAuthAuthorizeQuery {
  return {
    responseType: raw['response_type'],
    clientId: raw['client_id'],
    redirectUri: raw['redirect_uri'],
    scope: raw['scope'],
    state: raw['state'],
    codeChallenge: raw['code_challenge'],
    codeChallengeMethod: raw['code_challenge_method'],
  } as OAuthAuthorizeQuery;
}

/**
 * Builds the consent decision from the consent screen's native form POST. The web
 * page (OB-105) submits an `application/x-www-form-urlencoded` `<form>` — not a fetch
 * — because only a real form submission lets the browser follow the 302 back to the
 * client's `redirect_uri`; every value therefore arrives as a string. The camelCase
 * field names are the page's own (`oauthConsentDecisionSchema`'s), so they map across
 * verbatim except `approve`, which HTML form encoding cannot express as a boolean —
 * `grantAuthorization` re-parses the rest with the strict schema, so a malformed field
 * still surfaces as the `ValidationError` `toOAuthFlowError` maps.
 */
function toConsentDecision(raw: Record<string, unknown>): OAuthConsentDecision {
  return {
    responseType: raw['responseType'],
    clientId: raw['clientId'],
    redirectUri: raw['redirectUri'],
    scope: raw['scope'],
    state: raw['state'],
    codeChallenge: raw['codeChallenge'],
    codeChallengeMethod: raw['codeChallengeMethod'],
    approve: raw['approve'] === 'true',
  } as OAuthConsentDecision;
}

export function registerOAuthFlowRoutes(app: App): void {
  app.get('/oauth/authorize', { schema: { hide: true } }, async (request, reply) => {
    const query = toAuthorizeQuery(request.query as Record<string, unknown>);

    try {
      // Mints nothing (`authorizeRequest`'s own header): this call is validation
      // only, so a prefetch or a crawler following this URL cannot spend a code.
      await authorizeRequest(query, getContext());
    } catch (error) {
      const { status, body } = toOAuthFlowError(error);
      return reply.status(status).send(body);
    }

    // The query string is forwarded verbatim rather than re-serialized — the web
    // app's `/oauth/consent` page (OB-105) parses the same RFC parameters this
    // route did, and re-encoding them here would be a second place they could
    // drift from what the third-party client actually sent.
    const queryStart = request.url.indexOf('?');
    const queryString = queryStart === -1 ? '' : request.url.slice(queryStart);
    return reply.status(302).header('location', `/oauth/consent${queryString}`).send();
  });

  // `consent`, `token` and `revoke` share the form-urlencoded content-type parser —
  // registered on an encapsulated child instance so `authorize` above and every other
  // route on `app` keep the default JSON-only parser. `consent` needs it because the
  // consent screen (OB-105) submits a native `<form>` — the only way the browser will
  // follow the 302 back to the client's `redirect_uri` — not a JSON fetch. Fastify has
  // no built-in urlencoded parser (`enableScripts: false`, CLAUDE.md: no network
  // installs for a dependency this thin), so this reads the raw string and hands back a
  // plain record. The child inherits `app`'s identity `onRequest` hook, so `consent`
  // still runs with the logged-in user's context.
  void app.register((rfc: App, _opts, done) => {
    rfc.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_request, body, done) => {
        try {
          done(null, Object.fromEntries(new URLSearchParams(body as string)));
        } catch (error) {
          done(error as Error, undefined);
        }
      },
    );

    rfc.post('/oauth/consent', { schema: { hide: true } }, async (request, reply) => {
      const ctx = getContext();
      const decision = toConsentDecision(request.body as Record<string, unknown>);

      try {
        const outcome = await grantAuthorization(decision, ctx);
        const redirect = new URL(outcome.redirectUri);
        if (outcome.approved) {
          redirect.searchParams.set('code', outcome.code);
        } else {
          // RFC 6749 §4.1.2.1: the resource owner denied the request.
          redirect.searchParams.set('error', 'access_denied');
        }
        redirect.searchParams.set('state', outcome.state);
        return reply.status(302).header('location', redirect.toString()).send();
      } catch (error) {
        const { status, body } = toOAuthFlowError(error);
        return reply.status(status).send(body);
      }
    });

    rfc.post('/oauth/token', { schema: { hide: true } }, async (request, reply) => {
      const result = await exchangeToken(request.body);
      return reply.status(result.status).send(result.body);
    });

    // RFC 7009 §2.2: always `200`, whether or not `token` named anything —
    // `revokeToken` never throws, so there is no error branch here.
    rfc.post('/oauth/revoke', { schema: { hide: true } }, async (request, reply) => {
      await revokeToken(request.body);
      return reply.status(200).send();
    });

    done();
  });
}
