import type { ReactElement } from 'react';
import { useState } from 'react';

import { newIdempotencyKey } from '../api';
import { Button, ErrorBanner } from '../components';
import { OverduePanel } from './dunning/overdue-panel';
import { PolicyFormDialog } from './dunning/policy-form-dialog';
import { PolicyList } from './dunning/policy-list';
import {
  useCreateDunningPolicy,
  useDunningPolicies,
  useUpdateDunningPolicy,
} from './dunning/queries';
import type { DunningPolicy } from './dunning/queries';

/**
 * Dunning — overdue-reminder policies and their stage ladders (OB-132; the OB-129/130
 * dunning engine this is the front end for).
 *
 * ## What this screen is for, and what it deliberately does not do
 *
 * The engine sweep (`packages/server`'s daily tick) walks each policy's stages and sends
 * the highest-numbered one that has come due and has not already sent — this screen is
 * where that ladder is built and maintained, not where a reminder is sent by hand. There is
 * no "send now" button and there cannot be one from this contract: the API publishes no
 * route for it, because a reminder is a consequence of the schedule, not a click.
 *
 * ## Write controls are not hidden by permission (D-25)
 *
 * Unlike a route guard, `permissions` on `GET /v1/auth/me` is advisory — nothing in this
 * package hides a button because a role lacks a permission, the same way `dimensions.tsx`
 * and `sales.tsx` do not. `requirePermission` is enforced service-side and is what a role
 * matrix test (OB-054) proves; a caller who lacks `invoices.send` still sees every control
 * here and meets the refusal as a `permission_denied` `ErrorBanner`, phrased by
 * `presentApiError` as "Not available to you" rather than a control that quietly vanished.
 *
 * ## Structure
 *
 * A list of policies, a dialog shared between create and edit (`policy-form-dialog.tsx`),
 * and — secondary, read-only, below the fold — what is overdue right now
 * (`overdue-panel.tsx`), so the person building a ladder can see what it would be chasing
 * without leaving the screen to run the aging report.
 */
type Dialog =
  { readonly kind: 'create' } | { readonly kind: 'edit'; readonly policy: DunningPolicy };

export function DunningScreen(): ReactElement {
  const [dialog, setDialog] = useState<Dialog | null>(null);

  const policies = useDunningPolicies();
  const create = useCreateDunningPolicy();
  const update = useUpdateDunningPolicy();

  const items = policies.data?.items ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold text-text">Dunning</h1>
        <div className="flex-1" />
        <Button
          variant="primary"
          onClick={() => {
            create.reset();
            setDialog({ kind: 'create' });
          }}
        >
          New policy
        </Button>
      </div>

      {policies.isError && (
        <ErrorBanner
          error={policies.error}
          onRetry={() => {
            void policies.refetch();
          }}
        />
      )}

      <PolicyList
        policies={items}
        isPending={policies.isPending}
        onEdit={(policy) => {
          update.reset();
          setDialog({ kind: 'edit', policy });
        }}
      />

      <OverduePanel />

      <PolicyFormDialog
        title="New policy"
        description="A name and a ladder of at least one stage. Stages send in the order shown below."
        open={dialog?.kind === 'create'}
        submitLabel="Create policy"
        pending={create.isPending}
        error={create.error}
        onClose={() => {
          setDialog(null);
        }}
        onSubmit={(values) => {
          create.mutate(
            { ...values, idempotencyKey: newIdempotencyKey() },
            { onSuccess: () => setDialog(null) },
          );
        }}
      />

      <PolicyFormDialog
        title="Edit policy"
        description="Saving replaces the whole ladder — every stage the policy should have, including the ones left unchanged."
        open={dialog?.kind === 'edit'}
        submitLabel="Save"
        pending={update.isPending}
        error={update.error}
        initial={dialog?.kind === 'edit' ? dialog.policy : undefined}
        onClose={() => {
          setDialog(null);
        }}
        onSubmit={(values) => {
          if (dialog?.kind !== 'edit') return;
          update.mutate(
            { policyId: dialog.policy.id, ...values, idempotencyKey: newIdempotencyKey() },
            { onSuccess: () => setDialog(null) },
          );
        }}
      />
    </div>
  );
}
