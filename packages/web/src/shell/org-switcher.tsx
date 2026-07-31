import type { ReactElement } from 'react';
import { useState } from 'react';

import { newIdempotencyKey, presentApiError } from '../api';
import { CreateOrgForm } from '../auth/create-org';
import type { CallerIdentity } from '../auth/identity';
import { SignOutButton } from '../auth/sign-out';
import { useSwitchActiveOrg } from '../auth/switch-org';
import { Button, Dialog, DialogContent, DialogTrigger, FieldError, Select } from '../components';

/**
 * The header cluster: which organization is open, how to change it, how to add one, and how
 * to leave.
 *
 * It fills the shell's `orgIndicator` slot, which is where session-scoped controls belong —
 * `AppShell` takes it as a slot rather than rendering it so that the shell needs no session
 * to draw a login screen.
 *
 * The switch is `useSwitchActiveOrg`, and the cache clear it performs is the consequential
 * part of this whole ticket; the reasoning is in `src/query/client.ts` and the hook's own
 * header. Nothing here navigates: an accountant who switches from their own books to a
 * client's while reading the trial balance should be reading the client's trial balance, not
 * be returned to a landing page.
 */
export interface OrgControlsProps {
  readonly identity: CallerIdentity;
}

export function OrgControls({ identity }: OrgControlsProps): ReactElement {
  const [creating, setCreating] = useState(false);
  const switchOrg = useSwitchActiveOrg();

  return (
    <div className="flex items-center gap-2">
      {/* `FieldError` and not `ErrorBanner`: the header has no room for a banner, and this is
          the form-level use its own comment describes. The full presentation is still the
          shared table's — only the title is shown. */}
      {switchOrg.isError && <FieldError>{presentApiError(switchOrg.error).title}</FieldError>}

      {/* Width lives on this wrapper, not the trigger: `Select` carries `CONTROL_CLASSES`'
          `w-full`, which wins the source-order tie against a `w-*` on the trigger, so the
          only reliable cap is a sized box the full-width trigger fills. Without it the
          trigger grows to the org name and shoves the header past the phone's width. */}
      <div className="w-32 shrink-0 sm:w-48">
        <Select
          aria-label="Active organization"
          value={identity.activeOrgId}
          disabled={switchOrg.isPending}
          options={identity.memberships.map((membership) => ({
            value: membership.org.id,
            label: membership.org.name,
          }))}
          onValueChange={(orgId) => {
            // Minted at the point the user commits, and carried in the variables, so a repeat
            // of the same switch replays rather than issuing a second one.
            switchOrg.mutate({ orgId, idempotencyKey: newIdempotencyKey() });
          }}
        />
      </div>

      <Dialog open={creating} onOpenChange={setCreating}>
        {/* Hidden below `sm` via a wrapper, not `hidden` on the button: `Button` hard-codes
            `inline-flex`, which wins the source-order tie against `hidden`, so the button
            cannot hide itself. The header cannot hold the switcher, this, and sign-out at
            phone width without overflowing (a payment sheet inherits that width); creating an
            org is rare and stays one breakpoint up. */}
        <span className="hidden sm:inline-flex">
          <DialogTrigger asChild>
            <Button size="sm" variant="ghost">
              New organization
            </Button>
          </DialogTrigger>
        </span>
        <DialogContent
          title="Create an organization"
          description="A separate set of books, with you as its Owner."
        >
          <CreateOrgForm
            // There is an org scope here, so the starter charts can be listed. They are
            // offered, never preselected (D-23).
            canListChartTemplates
            submitLabel="Create and open"
            onCreated={(membership) => {
              setCreating(false);
              // Creating does not move the session — the active org belongs to the session
              // and not to the org — so the new books are opened by switching to them.
              switchOrg.mutate({ orgId: membership.org.id, idempotencyKey: newIdempotencyKey() });
            }}
          />
        </DialogContent>
      </Dialog>

      <SignOutButton />
    </div>
  );
}
