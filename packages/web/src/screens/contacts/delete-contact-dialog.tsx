import type { ReactElement, ReactNode } from 'react';

import { Button, Dialog, DialogClose, DialogContent, ErrorBanner } from '../../components';
import type { Contact } from './queries';
import {
  CONTACT_HAS_POSTINGS,
  CONTACT_ON_DRAFT,
  preconditionOf,
  useDeleteContact,
  useIntentKey,
  useSetContactActive,
} from './queries';

/**
 * Deleting a contact, and the two refusals that are not the same refusal.
 *
 * The server answers a delete it will not perform with one of two precondition tokens, and
 * it went to the trouble of having two because the situations differ in what the user
 * should do next:
 *
 * - `contact_has_postings` — the ledger names this contact on a posted line.
 *   `fk_journal_lines_contact` is `RESTRICT`, so this is **permanent**: no sequence of
 *   actions makes the row deletable, and deactivation is the entire remedy. The dialog
 *   therefore offers deactivation as its primary action, because that is what the user
 *   came here to accomplish.
 *
 * - `contact_on_draft` — an *unposted* draft names it. A draft is a form in progress
 *   (D-19), so the reference is removable and the contact deletes normally afterwards.
 *   The dialog offers a retry and does **not** offer deactivation: suggesting the
 *   permanent remedy for a temporary obstacle is precisely the confusion the two tokens
 *   exist to prevent.
 *
 * Anything else falls through to `ErrorBanner`, which already knows what every other code
 * means and must not be second-guessed here.
 */
export interface DeleteContactDialogProps {
  readonly contact: Contact | null;
  readonly onOpenChange: (open: boolean) => void;
}

export function DeleteContactDialog({
  contact,
  onOpenChange,
}: DeleteContactDialogProps): ReactElement {
  return (
    <Dialog open={contact !== null} onOpenChange={onOpenChange}>
      {contact !== null && (
        <DeleteContactContent
          key={contact.id}
          contact={contact}
          onDone={() => {
            onOpenChange(false);
          }}
        />
      )}
    </Dialog>
  );
}

function DeleteContactContent({
  contact,
  onDone,
}: {
  readonly contact: Contact;
  readonly onDone: () => void;
}): ReactElement {
  const remove = useDeleteContact();
  const deactivate = useSetContactActive();
  const intentKey = useIntentKey();

  const precondition = preconditionOf(remove.error);
  const pending = remove.isPending || deactivate.isPending;

  /**
   * The same key for every attempt at this one deletion, including the retry offered after
   * `contact_on_draft`. A failed claim rolls back rather than poisoning the key (see the
   * idempotency service), and the request body never changes — the intent is "delete this
   * contact", and it is the same intent after the user has gone and emptied the draft.
   */
  function requestDelete(): void {
    remove.mutate(
      { contactId: contact.id, idempotencyKey: intentKey(`delete:${contact.id}`) },
      { onSuccess: onDone },
    );
  }

  if (precondition === CONTACT_HAS_POSTINGS) {
    return (
      <Refusal
        title="This contact is on posted entries"
        body={
          <>
            <p>
              <strong className="font-medium text-text">{contact.displayName}</strong> is named by
              at least one posted journal line, so it cannot be deleted — the entries that point at
              it would stop saying who the amount was with.
            </p>
            <p>
              Deactivating is the removal available here: the contact keeps its history, disappears
              from the pickers, and cannot be named on a new entry.
            </p>
          </>
        }
        actions={
          <>
            <DialogClose asChild>
              <Button disabled={pending}>Cancel</Button>
            </DialogClose>
            <Button
              variant="primary"
              disabled={pending}
              onClick={() => {
                deactivate.mutate(
                  {
                    contactId: contact.id,
                    active: false,
                    idempotencyKey: intentKey(`deactivate:${contact.id}`),
                  },
                  { onSuccess: onDone },
                );
              }}
            >
              Deactivate instead
            </Button>
          </>
        }
        error={deactivate.error}
      />
    );
  }

  if (precondition === CONTACT_ON_DRAFT) {
    return (
      <Refusal
        title="This contact is on an unposted draft"
        body={
          <>
            <p>
              A draft journal names{' '}
              <strong className="font-medium text-text">{contact.displayName}</strong>. Nothing has
              been posted, so this is not permanent: remove the contact from the draft line, or
              discard the draft, and it deletes.
            </p>
            <p>There is no need to deactivate it for this.</p>
          </>
        }
        actions={
          <>
            <DialogClose asChild>
              <Button disabled={pending}>Close</Button>
            </DialogClose>
            <Button variant="danger" disabled={pending} onClick={requestDelete}>
              {pending ? 'Deleting…' : 'Try delete again'}
            </Button>
          </>
        }
        error={null}
      />
    );
  }

  return (
    <DialogContent
      title="Delete contact"
      description="A directory row, not a record of what happened — deleting one that nothing references restates nothing."
      footer={
        <>
          <DialogClose asChild>
            <Button disabled={pending}>Cancel</Button>
          </DialogClose>
          <Button variant="danger" disabled={pending} onClick={requestDelete}>
            {pending ? 'Deleting…' : 'Delete'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-base text-text-muted">
        <p>
          Delete <strong className="font-medium text-text">{contact.displayName}</strong>?
        </p>
        <p>
          If the ledger already names this contact the deletion is refused and nothing is lost — the
          books decide, not this dialog.
        </p>
        {/* `precondition === null` here by construction, so this is every failure the two
            branches above do not claim: a permission failure, a 404, a dropped connection. */}
        {remove.error !== null && <ErrorBanner error={remove.error} />}
      </div>
    </DialogContent>
  );
}

function Refusal({
  title,
  body,
  actions,
  error,
}: {
  readonly title: string;
  readonly body: ReactNode;
  readonly actions: ReactNode;
  readonly error: unknown;
}): ReactElement {
  return (
    <DialogContent title={title} footer={actions}>
      <div className="flex flex-col gap-3 text-base text-text-muted">
        {body}
        {error !== undefined && error !== null && <ErrorBanner error={error} />}
      </div>
    </DialogContent>
  );
}
