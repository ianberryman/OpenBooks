import type { ReactElement } from 'react';

import { Button, Dialog, DialogClose, DialogContent, ErrorBanner } from '../../components';
import type { RecurringJournalTemplate } from './queries';
import { useDeactivateTemplate, useIntentKey } from './queries';

/**
 * Retiring a template — the one-way door, separate from pause/resume (`queries.ts`'s
 * `useSetTemplateActive`, wired on the list itself as a toggle) —
 * `recurring-invoices/deactivate-dialog.tsx`'s shape.
 *
 * `POST …/deactivate` is idempotent on the server rather than refusing an already-inactive
 * template, so there is no refusal to branch on here the way `contacts/delete-contact-
 * dialog.tsx` branches on two — this dialog is a plain confirmation and `ErrorBanner`
 * already knows what to say about anything else that goes wrong.
 */
export interface DeactivateTemplateDialogProps {
  readonly template: RecurringJournalTemplate | null;
  readonly onOpenChange: (open: boolean) => void;
}

export function DeactivateTemplateDialog({
  template,
  onOpenChange,
}: DeactivateTemplateDialogProps): ReactElement {
  return (
    <Dialog open={template !== null} onOpenChange={onOpenChange}>
      {template !== null && (
        <DeactivateTemplateContent
          key={template.id}
          template={template}
          onDone={() => {
            onOpenChange(false);
          }}
        />
      )}
    </Dialog>
  );
}

function DeactivateTemplateContent({
  template,
  onDone,
}: {
  readonly template: RecurringJournalTemplate;
  readonly onDone: () => void;
}): ReactElement {
  const deactivate = useDeactivateTemplate();
  const intentKey = useIntentKey();

  return (
    <DialogContent
      title="Retire this recurring journal?"
      description="The engine stops materialising journals from it. This cannot be undone from here."
      footer={
        <>
          <DialogClose asChild>
            <Button disabled={deactivate.isPending}>Cancel</Button>
          </DialogClose>
          <Button
            variant="danger"
            disabled={deactivate.isPending}
            onClick={() => {
              deactivate.mutate(
                {
                  templateId: template.id,
                  idempotencyKey: intentKey(`deactivate:${template.id}`),
                },
                { onSuccess: onDone },
              );
            }}
          >
            {deactivate.isPending ? 'Retiring…' : 'Retire'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-base text-text-muted">
        <p>
          <strong className="font-medium text-text">{template.name}</strong> will no longer
          materialise new journals. Nothing already posted from it is affected — every cycle it has
          already run stays exactly as it is, because nothing here is ever deleted.
        </p>
        <p>
          Pausing is the reversible alternative, from the toggle next to this template on the list —
          use that instead if this is temporary.
        </p>
        {deactivate.isError && <ErrorBanner error={deactivate.error} />}
      </div>
    </DialogContent>
  );
}
