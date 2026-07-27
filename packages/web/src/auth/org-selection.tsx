import type { ReactElement } from 'react';

import { newIdempotencyKey } from '../api';
import { Button, ErrorBanner } from '../components';
import { CreateOrgForm } from './create-org';
import type { CallerIdentity } from './identity';
import { useSwitchActiveOrg } from './switch-org';

/**
 * Where a signed-in caller with no active organization lands.
 *
 * Two populations reach it and both are real. A user who belongs to organizations but whose
 * session points at none — `GET /v1/auth/me` answers for exactly this case, which is why it
 * is gated on being a person rather than on having an org scope. And a user who belongs to
 * none at all, either because they were removed from their last one or because they are
 * about to create their first. Neither can be sent to a login form: their session is fine,
 * and signing in again would succeed and change nothing.
 */
export interface OrgSelectionScreenProps {
  readonly identity: CallerIdentity;
}

export function OrgSelectionScreen({ identity }: OrgSelectionScreenProps): ReactElement {
  const switchOrg = useSwitchActiveOrg();

  return (
    <div className="mx-auto flex w-full max-w-prose flex-col gap-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Choose an organization</h1>
        <p className="text-text-muted">
          {identity.memberships.length === 0
            ? 'You are not a member of any organization yet.'
            : 'Pick the books to open, or start a new set.'}
        </p>
      </div>

      {switchOrg.isError && <ErrorBanner error={switchOrg.error} />}

      {identity.memberships.length > 0 && (
        <ul className="flex flex-col gap-2">
          {identity.memberships.map((membership) => (
            <li
              key={membership.org.id}
              className="flex items-center gap-3 rounded-lg border border-border bg-surface p-3"
            >
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-medium">{membership.org.name}</span>
                <span className="text-xs text-text-subtle">{membership.roleCode}</span>
              </div>
              <Button
                variant="primary"
                size="sm"
                disabled={switchOrg.isPending}
                onClick={() => {
                  switchOrg.mutate({
                    orgId: membership.org.id,
                    idempotencyKey: newIdempotencyKey(),
                  });
                }}
              >
                Open
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4">
        <h2 className="font-semibold">Create an organization</h2>
        <CreateOrgForm
          // No org scope here, so the starter charts cannot be listed — see the prop's own
          // note. What this caller gets is D-23's default: an organization with no accounts.
          canListChartTemplates={false}
          submitLabel="Create and open"
          onCreated={(membership) => {
            // Creating does not move the session — the active org belongs to the session,
            // not to the org — so the new books are opened by switching to them.
            switchOrg.mutate({ orgId: membership.org.id, idempotencyKey: newIdempotencyKey() });
          }}
        />
      </div>
    </div>
  );
}
