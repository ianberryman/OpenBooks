import { z } from 'zod';

/**
 * The OAuth authorization server's wire contracts (OB-097; ROADMAP D-53 through D-56, D-61).
 *
 * OAuth 2.1: authorization-code with PKCE mandatory. Implicit and resource-owner-password
 * grants are refused by design (D-53) — both hand a third party more than a code exchange
 * does, and are not modelled here at all rather than modelled and rejected at runtime.
 *
 * `.meta({ id })` (OB-104) on this project's own JSON shapes — client management, the
 * consent decision, and connected apps — now that `/v1/oauth-clients`, `/v1/connected-apps`
 * and the consent POST give them routes. The `authorize` query and every RFC 6749/7009
 * wire shape (`oauthTokenRequestSchema`, `oauthTokenResponseSchema`, `oauthTokenErrorSchema`,
 * `oauthRevocationRequestSchema`) stay un-ided on purpose: those endpoints are wired
 * OUTSIDE the typed envelope in `transport/routes/oauth-flow.ts` (form-encoded bodies,
 * snake_case, RFC status codes), so a `components.schemas` entry for them would be
 * $ref'd by nothing.
 *
 * Every shape here is camelCase **except** the token and revocation endpoints, called out
 * at their own definitions: those are RFC 6749/RFC 7009 wire formats, not this project's
 * JSON contract, and `oauth-flow.ts`'s header repeats why the OAuth endpoints stay outside
 * the typed envelope other routes use.
 */

export const OAUTH_GRANT_TYPES = ['authorization_code', 'refresh_token'] as const;
export type OAuthGrantType = (typeof OAUTH_GRANT_TYPES)[number];

export const oauthGrantTypeSchema = z.enum(OAUTH_GRANT_TYPES).meta({
  description:
    'The two grants OpenBooks issues tokens for (D-53). `implicit` and `password` are refused ' +
    'by design and are not members of this enum at all.',
});

export const PKCE_METHODS = ['S256'] as const;
export type PkceMethod = (typeof PKCE_METHODS)[number];

export const pkceMethodSchema = z.enum(PKCE_METHODS).meta({
  description:
    'The PKCE code-challenge method. `S256` only — `plain` is a downgrade from the property ' +
    'PKCE exists for and is never accepted, mandatory since D-53.',
});

const OAUTH_CLIENT_NAME_MAX_LENGTH = 120;

/**
 * Registers an OAuth client. Clients are registered by an org admin under
 * `integrations.write` (D-53) — there is no public dynamic client registration
 * (RFC 7591); a self-service registration endpoint is an anti-abuse surface of its own
 * and is explicitly out of M5.
 */
export const registerOAuthClientRequestSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(OAUTH_CLIENT_NAME_MAX_LENGTH).meta({
      description: 'Display name for the client, shown to a user on the consent screen.',
    }),
    redirectUris: z
      .array(z.url())
      .min(1)
      .meta({
        description:
          'The redirect URIs this client may be sent back to. `authorize` refuses a request ' +
          'naming any URI outside this set — the classic open-redirect the whole flow depends ' +
          'on closing.',
      }),
  })
  .meta({
    id: 'RegisterOAuthClientRequest',
    description: 'Registers a third-party client, admin-registered and never self-service (D-53).',
  });

export type RegisterOAuthClientRequest = z.infer<typeof registerOAuthClientRequestSchema>;

/**
 * An OAuth client as the API returns it — never carrying the secret. See
 * `oauthClientWithSecretSchema` for the one response that does.
 */
export const oauthClientSchema = z
  .strictObject({
    id: z.uuid(),
    name: z.string(),
    clientId: z.string().meta({
      description: 'The public client identifier presented at `authorize` and `token`.',
    }),
    redirectUris: z.array(z.string()),
    createdAt: z.iso.datetime(),
    deactivatedAt: z.iso
      .datetime()
      .nullable()
      .meta({
        description:
          'Set once a client is deactivated. A deactivated client cannot obtain a new ' +
          'token, and D-61 logs the deactivation as a `security_events` row.',
      }),
  })
  .meta({
    id: 'OAuthClient',
    description: 'A registered third-party OAuth client, never carrying its secret.',
  });

export type OAuthClient = z.infer<typeof oauthClientSchema>;

/**
 * Returned once, at registration, exactly like an API key's full value
 * (`apiKeyWithSecretSchema`) and for the same reason (D-61): the secret is stored as a
 * hash, so this is the only response that will ever carry it in the clear.
 */
export const oauthClientWithSecretSchema = z
  .strictObject({
    ...oauthClientSchema.shape,
    clientSecret: z.string().meta({
      description:
        'The client secret, shown exactly once. Not recoverable — losing it means ' +
        're-registering the client.',
    }),
  })
  .meta({
    id: 'OAuthClientWithSecret',
    description: 'A registered OAuth client with its secret, returned exactly once (D-61).',
  });

export type OAuthClientWithSecret = z.infer<typeof oauthClientWithSecretSchema>;

/** Local and inline rather than through `pageSchema` — `dunningPolicyPageSchema`'s reasoning. */
export const oauthClientPageSchema = z
  .strictObject({
    items: z.array(oauthClientSchema),
    nextCursor: z.string().nullable(),
  })
  .meta({
    id: 'OAuthClientPage',
    description: 'One page of the org’s registered OAuth clients.',
  });

export type OAuthClientPage = z.infer<typeof oauthClientPageSchema>;

/**
 * The `authorize` request. RFC 6749 names these query parameters in snake_case on the
 * wire, but `authorize` is a redirect-driven browser flow the server itself parses out of
 * the querystring (unlike `token`, which a client library form-encodes directly against
 * the RFC), so it is modelled in the project's own camelCase like every other query
 * schema — OB-104's transport layer is what maps the RFC's `response_type` etc. onto
 * these fields.
 */
export const oauthAuthorizeQuerySchema = z.strictObject({
  responseType: z.literal('code'),
  clientId: z.string(),
  redirectUri: z.url(),
  scope: z.string().meta({
    description:
      'Space-separated permission keys (D-54): the scope catalog is the permission catalog, ' +
      'not a second vocabulary. A key outside the 48-key catalog is refused at grant time.',
  }),
  state: z.string(),
  codeChallenge: z.string(),
  codeChallengeMethod: pkceMethodSchema,
});

export type OAuthAuthorizeQuery = z.infer<typeof oauthAuthorizeQuerySchema>;

/**
 * What the consent screen renders: the client's display name and the exact scopes it is
 * asking for, plus whether the user has already consented to a superset (so a return trip
 * can be a silent re-issue). Fetched by the web consent page from `GET
 * /v1/oauth/authorization-details` — a session-authenticated read with no permission of its
 * own (a user consenting to delegate *their* access is not an `integrations.*` admin act),
 * modelled on `GET /v1/auth/me`.
 */
export const oauthAuthorizationDetailsSchema = z
  .strictObject({
    clientName: z.string(),
    scope: z.array(z.string()),
    alreadyConsented: z.boolean(),
  })
  .meta({
    id: 'OAuthAuthorizationDetails',
    description:
      'The client name and requested scopes the consent screen shows, plus whether the ' +
      'user has already granted a superset of them.',
  });

export type OAuthAuthorizationDetails = z.infer<typeof oauthAuthorizationDetailsSchema>;

/**
 * The consent screen's own submission: the same parameters the client's `authorize`
 * request carried, echoed back so the decision can be replayed against them, plus
 * whether the user approved.
 *
 * Ided, unlike `oauthAuthorizeQuerySchema`: this is `POST /oauth/consent`'s own JSON body,
 * submitted by this project's web app (not a third-party client), so it is this project's
 * camelCase contract rather than an RFC wire shape — `oauth-flow.ts`'s header explains why
 * the route itself is still wired outside the typed *response* envelope (the browser is
 * redirected to the client's `redirect_uri`, never handed this project's error shape).
 */
export const oauthConsentDecisionSchema = z
  .strictObject({
    ...oauthAuthorizeQuerySchema.shape,
    approve: z.boolean(),
  })
  .meta({
    id: 'OAuthConsentDecision',
    description:
      'The user’s decision on the consent screen: the `authorize` request’s own parameters, ' +
      'echoed back so they can be re-validated, plus whether the user approved.',
  });

export type OAuthConsentDecision = z.infer<typeof oauthConsentDecisionSchema>;

/**
 * The token endpoint. RFC 6749 form-encoded; snake_case is the wire contract, not the
 * project camelCase — deliberate (OB-097). A client library that speaks OAuth sends
 * these field names verbatim; translating them to camelCase here would mean either a
 * second translation layer or a contract that reads like this project everywhere except
 * the one endpoint every off-the-shelf OAuth client already knows how to call.
 *
 * A discriminated union on `grant_type` rather than one object with optional fields:
 * `authorization_code` and `refresh_token` share no required field but `client_id`, and
 * an object with everything optional would accept a request naming a `code` and a
 * `refresh_token` together, which is not a request either grant recognizes.
 */
export const oauthTokenRequestSchema = z.discriminatedUnion('grant_type', [
  z.strictObject({
    grant_type: z.literal('authorization_code'),
    code: z.string(),
    redirect_uri: z.url(),
    client_id: z.string(),
    code_verifier: z.string(),
  }),
  z.strictObject({
    grant_type: z.literal('refresh_token'),
    refresh_token: z.string(),
    client_id: z.string(),
  }),
]);

export type OAuthTokenRequest = z.infer<typeof oauthTokenRequestSchema>;

/** RFC 6749 §5.1's success body — snake_case, see `oauthTokenRequestSchema`. */
export const oauthTokenResponseSchema = z.strictObject({
  access_token: z.string(),
  token_type: z.literal('Bearer'),
  expires_in: z.int().positive(),
  refresh_token: z.string().optional(),
  scope: z.string(),
});

export type OAuthTokenResponse = z.infer<typeof oauthTokenResponseSchema>;

/** RFC 6749 §5.2's error body — snake_case, see `oauthTokenRequestSchema`. */
export const oauthTokenErrorSchema = z.strictObject({
  error: z.string(),
  error_description: z.string().optional(),
});

export type OAuthTokenError = z.infer<typeof oauthTokenErrorSchema>;

/** RFC 7009's revocation request — snake_case, see `oauthTokenRequestSchema`. */
export const oauthRevocationRequestSchema = z.strictObject({
  token: z.string(),
  client_id: z.string(),
});

export type OAuthRevocationRequest = z.infer<typeof oauthRevocationRequestSchema>;

/**
 * A client a user has authorized, as they see it under `integrations.read` — the
 * "connected apps" list a user reviews to see who holds a delegated credential over
 * their own account, and revokes from.
 */
export const connectedAppSchema = z
  .strictObject({
    clientId: z.string(),
    name: z.string(),
    scope: z.array(z.string()).meta({
      description: 'The permission keys this consent granted (D-54), not the user’s full role.',
    }),
    consentedAt: z.iso.datetime(),
    lastUsedAt: z.iso.datetime().nullable(),
  })
  .meta({
    id: 'ConnectedApp',
    description: 'A client the caller has authorized, as they see it under `integrations.read`.',
  });

export type ConnectedApp = z.infer<typeof connectedAppSchema>;

/** Local and inline, `oauthClientPageSchema`'s reasoning. */
export const connectedAppPageSchema = z
  .strictObject({
    items: z.array(connectedAppSchema),
    nextCursor: z.string().nullable(),
  })
  .meta({
    id: 'ConnectedAppPage',
    description: 'One page of the apps the caller has authorized.',
  });

export type ConnectedAppPage = z.infer<typeof connectedAppPageSchema>;
