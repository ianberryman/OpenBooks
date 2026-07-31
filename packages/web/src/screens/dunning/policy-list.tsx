import type { ReactElement } from 'react';
import { useState } from 'react';

import { newIdempotencyKey } from '../../api';
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  ErrorBanner,
  Pill,
  ResponsiveTable,
} from '../../components';
import { cx } from '../../lib/cx';
import { EmptyRow, TABLE_CLASSES, TD_CLASSES, TH_CLASSES } from '../settings/section';
import { useDeactivateDunningPolicy, useSetDunningPolicyActive } from './queries';
import type { DunningPolicy } from './queries';

/**
 * The policy table: name, ladder length, active/paused, and the row actions.
 *
 * ## Pause/resume and deactivate are two controls, not one, even though both end at the
 * ## same `isActive: false`
 *
 * `dimensions.tsx`'s archive/delete pair is the model, but the split here is not the same
 * shape: an archived dimension value cannot be deleted back, whereas pausing and
 * deactivating a policy both simply flip `isActive` and either one can be reversed by the
 * same "Resume" button — `UpdateDunningPolicyRequest`'s own field carries no second state
 * for "retired" versus "paused". What is still worth two controls is the friction: pausing
 * is a one-click toggle for "not right now", and deactivating is the deliberate "stop
 * chasing with this ladder" action the ticket calls out on its own, so it asks for
 * confirmation the toggle does not.
 */
export interface PolicyListProps {
  readonly policies: readonly DunningPolicy[];
  readonly isPending: boolean;
  readonly onEdit: (policy: DunningPolicy) => void;
}

export function PolicyList({ policies, isPending, onEdit }: PolicyListProps): ReactElement {
  const setActive = useSetDunningPolicyActive();
  const deactivate = useDeactivateDunningPolicy();
  const [confirming, setConfirming] = useState<DunningPolicy | null>(null);

  return (
    <div className="flex flex-col gap-3">
      {setActive.isError && <ErrorBanner error={setActive.error} />}

      <ResponsiveTable>
        <table className={TABLE_CLASSES}>
          <caption className="sr-only">Dunning policies</caption>
          <thead>
            <tr>
              <th scope="col" className={TH_CLASSES}>
                Name
              </th>
              <th scope="col" className={TH_CLASSES}>
                Stages
              </th>
              <th scope="col" className={TH_CLASSES}>
                Status
              </th>
              <th scope="col" className={cx(TH_CLASSES, 'text-right')}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {policies.length === 0 && (
              <EmptyRow columns={4}>
                {isPending
                  ? 'Loading…'
                  : 'No dunning policies yet. Invoices fall overdue with nothing chasing them until one exists.'}
              </EmptyRow>
            )}
            {policies.map((policy) => (
              <tr key={policy.id}>
                <td className={TD_CLASSES}>
                  <span className="text-text">{policy.name}</span>
                </td>
                <td className={TD_CLASSES}>
                  {policy.stages.length} {policy.stages.length === 1 ? 'stage' : 'stages'}
                </td>
                <td className={TD_CLASSES}>
                  <Pill tone={policy.isActive ? 'positive' : 'muted'}>
                    {policy.isActive ? 'Active' : 'Paused'}
                  </Pill>
                </td>
                <td className={cx(TD_CLASSES, 'text-right')}>
                  <div className="flex justify-end gap-1">
                    <Button
                      size="sm"
                      onClick={() => {
                        onEdit(policy);
                      }}
                    >
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => {
                        setActive.mutate({
                          policyId: policy.id,
                          isActive: !policy.isActive,
                          idempotencyKey: newIdempotencyKey(),
                        });
                      }}
                    >
                      {policy.isActive ? 'Pause' : 'Resume'}
                    </Button>
                    {policy.isActive && (
                      <Button
                        size="sm"
                        onClick={() => {
                          deactivate.reset();
                          setConfirming(policy);
                        }}
                      >
                        Deactivate
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ResponsiveTable>

      <Dialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
      >
        <DialogContent
          title="Deactivate policy"
          description="Stops this ladder from sending anything further until it is resumed."
          footer={
            <>
              <DialogClose asChild>
                <Button>Cancel</Button>
              </DialogClose>
              <Button
                variant="primary"
                disabled={deactivate.isPending}
                onClick={() => {
                  if (confirming === null) return;
                  deactivate.mutate(
                    { policyId: confirming.id, idempotencyKey: newIdempotencyKey() },
                    { onSuccess: () => setConfirming(null) },
                  );
                }}
              >
                Deactivate policy
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-3">
            <p className="text-sm text-text">
              {/* Not `variant="danger"`, and not phrased as irreversible: unlike deleting an
                  axis, nothing here is destroyed. The same "Resume" control on this row
                  turns it back on, with the ladder exactly as it was left. */}
              Nothing already sent is undone, and the stages themselves are kept — resuming later
              restores the same ladder rather than asking it to be rebuilt.
            </p>
            {deactivate.isError && <ErrorBanner error={deactivate.error} />}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
