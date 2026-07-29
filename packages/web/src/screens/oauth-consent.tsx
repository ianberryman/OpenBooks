import { useQuery } from '@tanstack/react-query';
import type { ReactElement, ReactNode } from 'react';
import { useLocation } from 'react-router-dom';

import { api, unwrap } from '../api';
import { Button } from '../components';

/**
 * The OAuth consent screen — `GET /oauth/authorize` (server, `oauth-flow.ts`) 302-redirects
 * a logged-in user here, forwarding the RFC 6749 query verbatim (OB-053, OB-098, OB-104;
 * ROADMAP D-53, D-54, D-61). Reached only by that redirect: there is no nav entry for it
 * (see `shell/nav.ts`), and `App.tsx` mounts it inside `SignedInRoutes` because it needs a
 * live session to answer "does this user consent".
 *
 * ## Reading the query, and the two vocabularies in play
 *
 * The URL carries RFC 6749's own `snake_case` names (`response_type`, `client_id`, …) —
 * `oauth-flow.ts`'s own comment: "the web app's `/oauth/consent` page (OB-105) parses the
 * same RFC parameters" the server's `/oauth/authorize` route received, forwarded
 * unchanged rather than re-encoded, specifically so this page and that route never drift
 * on how they read the same string. `getOAuthAuthorizationDetails`'s typed query is
 * `camelCase` (`responseType`, `clientId`, …) — `openapi.json`'s own convention for every
 * other endpoint — so `toDetailsQuery` below maps one to the other exactly the way the
 * server's own `toAuthorizeQuery` (`oauth-flow.ts`) does, by hand, in one place.
 *
 * `useLocation().search` rather than `window.location.search` directly: `BrowserRouter`
 * keeps the two in lockstep in the running app, and reading through the router is what
 * lets a test mount this screen under `MemoryRouter` at a chosen path instead of having to
 * reach past React Router into the real browser location.
 *
 * ## Approve / Deny are native form posts, not this package's typed API client
 *
 * `POST /oauth/consent` answers a `302` straight to the third-party client's own
 * `redirect_uri`, carrying the authorization code (RFC 6749 §4.1.2) — a response only a
 * browser-native form submission follows across origins. A `fetch`-based call (which is
 * what every other write in this package makes, through `api.POST`) would receive that
 * redirect as an opaque, unfollowable response instead of navigating the tab, so this is
 * the one write in the whole application that is a plain `<form method="POST">` rather
 * than routed through `src/api/`.
 *
 * **Known gap, flagged rather than silently worked around:** `oauth-flow.ts`'s own header
 * states that `/oauth/consent` keeps "the default JSON-only parser" — only `/oauth/token`
 * and `/oauth/revoke` get the form-urlencoded content-type parser registered
 * (`addContentTypeParser` on a child Fastify instance covering those two routes alone). A
 * native `<form>`'s default `enctype`, `application/x-www-form-urlencoded`, therefore has
 * no parser on `/oauth/consent` today and the request now fails before `grantAuthorization`
 * ever runs. Fixing that is a server-side change to `registerOAuthFlowRoutes` outside this
 * ticket's screens-only scope; the hidden field names below are written to match
 * `OAuthConsentDecision`'s own field names so that once the parser gap closes, no change is
 * needed here.
 */

interface AuthorizeParams {
  readonly responseType: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scope: string;
  readonly state: string;
  readonly codeChallenge: string;
  readonly codeChallengeMethod: string;
}

function paramsFromSearch(search: string): AuthorizeParams | null {
  const raw = new URLSearchParams(search);
  const responseType = raw.get('response_type');
  const clientId = raw.get('client_id');
  const redirectUri = raw.get('redirect_uri');
  const scope = raw.get('scope');
  const state = raw.get('state');
  const codeChallenge = raw.get('code_challenge');
  const codeChallengeMethod = raw.get('code_challenge_method');

  if (
    responseType === null ||
    clientId === null ||
    redirectUri === null ||
    scope === null ||
    state === null ||
    codeChallenge === null ||
    codeChallengeMethod === null
  ) {
    return null;
  }

  return { responseType, clientId, redirectUri, scope, state, codeChallenge, codeChallengeMethod };
}

/** `getOAuthAuthorizationDetails`'s own query shape — see the module header. */
function toDetailsQuery(params: AuthorizeParams): {
  responseType: 'code';
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
} {
  return {
    responseType: 'code',
    clientId: params.clientId,
    redirectUri: params.redirectUri,
    scope: params.scope,
    state: params.state,
    codeChallenge: params.codeChallenge,
    codeChallengeMethod: 'S256',
  };
}

function ConsentShell({ children }: { readonly children: ReactNode }): ReactElement {
  return (
    <div className="min-h-screen bg-canvas p-4 text-text sm:p-8">
      <div className="mx-auto flex w-full max-w-md flex-col gap-4">{children}</div>
    </div>
  );
}

/** Every field empty — never sent, since the query below is `enabled` only when real
 * params were parsed, but a value the hook can type its query against unconditionally
 * (React's rule that hooks run every render, `params === null`'s early return included). */
const EMPTY_PARAMS: AuthorizeParams = {
  responseType: '',
  clientId: '',
  redirectUri: '',
  scope: '',
  state: '',
  codeChallenge: '',
  codeChallengeMethod: '',
};

export function OAuthConsentScreen(): ReactElement {
  const location = useLocation();
  const params = paramsFromSearch(location.search);

  const details = useQuery({
    queryKey: ['oauth-consent', location.search],
    queryFn: async () =>
      unwrap(
        await api.GET('/v1/oauth/authorization-details', {
          params: { query: toDetailsQuery(params ?? EMPTY_PARAMS) },
        }),
      ),
    enabled: params !== null,
    retry: false,
  });

  if (params === null) {
    return (
      <ConsentShell>
        <p className="text-text-muted">
          This authorization link is missing parameters and cannot be completed.
        </p>
      </ConsentShell>
    );
  }

  if (details.isPending) {
    return (
      <ConsentShell>
        <p className="text-text-subtle">Loading…</p>
      </ConsentShell>
    );
  }

  if (details.isError) {
    return (
      <ConsentShell>
        {/* No detail beyond this: an invalid client, an unregistered redirect URI and an
            expired session all read the same to whoever landed here — `public-
            invoice.tsx`'s reasoning for the same one-line refusal, applied to a page whose
            failure paths are similarly not this user's to diagnose. */}
        <p className="text-text-muted">
          This authorization request is no longer valid. Ask the application to start over.
        </p>
      </ConsentShell>
    );
  }

  return <ConsentForm params={params} details={details.data} />;
}

interface AuthorizationDetails {
  readonly clientName: string;
  readonly scope: readonly string[];
  readonly alreadyConsented: boolean;
}

function ConsentForm({
  params,
  details,
}: {
  readonly params: AuthorizeParams;
  readonly details: AuthorizationDetails;
}): ReactElement {
  return (
    <ConsentShell>
      <div className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-6">
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-semibold text-text">
            {details.clientName} is requesting access to:
          </h1>
          {details.alreadyConsented && (
            <p className="text-xs text-text-subtle">
              You have already granted at least this much access to this application.
            </p>
          )}
        </div>

        <ul className="flex flex-col gap-1">
          {details.scope.map((permission) => (
            <li key={permission} className="font-mono text-sm text-text-muted">
              {permission}
            </li>
          ))}
        </ul>

        <div className="flex justify-end gap-2 border-t border-border pt-4">
          <ConsentDecisionForm params={params} approve={false}>
            <Button type="submit" variant="secondary">
              Deny
            </Button>
          </ConsentDecisionForm>
          <ConsentDecisionForm params={params} approve>
            <Button type="submit" variant="primary">
              Approve
            </Button>
          </ConsentDecisionForm>
        </div>
      </div>
    </ConsentShell>
  );
}

/**
 * One native `<form>` per decision, each carrying the authorize request's own parameters
 * as hidden fields plus `approve` — see the module header for why this is a form post and
 * not the typed API client. Two forms rather than one form with two submit buttons: a
 * shared form would need `formAction`/button-value plumbing to vary one field by which
 * button was pressed, and two plain forms say the same thing with no such indirection.
 */
function ConsentDecisionForm({
  params,
  approve,
  children,
}: {
  readonly params: AuthorizeParams;
  readonly approve: boolean;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <form method="POST" action="/oauth/consent">
      <input type="hidden" name="responseType" value={params.responseType} />
      <input type="hidden" name="clientId" value={params.clientId} />
      <input type="hidden" name="redirectUri" value={params.redirectUri} />
      <input type="hidden" name="scope" value={params.scope} />
      <input type="hidden" name="state" value={params.state} />
      <input type="hidden" name="codeChallenge" value={params.codeChallenge} />
      <input type="hidden" name="codeChallengeMethod" value={params.codeChallengeMethod} />
      <input type="hidden" name="approve" value={approve ? 'true' : 'false'} />
      {children}
    </form>
  );
}
