import type { ReactElement } from 'react';
import { useMemo, useState } from 'react';

import { Button, ErrorBanner, Field, FieldLabel, ResponsiveTable, Select } from '../components';
import { ContactFormDialog } from './contacts/contact-form';
import { DeleteContactDialog } from './contacts/delete-contact-dialog';
import type { Contact, ContactFilters } from './contacts/queries';
import {
  NO_CONTACT_FILTERS,
  useContactList,
  useIntentKey,
  useSetContactActive,
} from './contacts/queries';

/**
 * Contacts (OB-049) — the org's directory of the parties its entries name.
 *
 * Three rules from the server shape this screen, and the screen's job is to make them
 * legible rather than to restate them:
 *
 * 1. **One contact is both customer and vendor, not two records.** The flags are
 *    independent and neither is required, so the filters are three separate tri-states and
 *    the form is two checkboxes — see the header of `contacts/contact-form.tsx`.
 * 2. **A contact the ledger names cannot be deleted, only deactivated**, and the server
 *    distinguishes a posted reference from a draft one because the remedies differ. That
 *    distinction is the whole of `contacts/delete-contact-dialog.tsx`.
 * 3. **The list is keyset-paged over `(created_at, id)` (D-21)** and is therefore not
 *    alphabetical. `SORT_OPTIONS` below says what this screen does about that and what it
 *    refuses to pretend.
 */

type SortMode = 'created' | 'name';

/**
 * ## Ordering, and the sort this screen is careful not to claim
 *
 * The server pages this list oldest-first by creation, and it does so *instead of* by name
 * on purpose: `displayName` is the field most likely to be edited — it is how a business
 * records that a customer rebranded — and a keyset cursor over a mutable column silently
 * drops the rows that move behind it. A contact renamed from `Zenith` to `Acme` mid-paging
 * appears on no page at all. D-27 solved the same problem for the chart of accounts by
 * making the sort key immutable, and that answer is not available here: refusing to rename
 * a customer is not a trade any pagination scheme is worth (D-28).
 *
 * So a name sort is offered and it sorts **only what has been loaded**, and both the option
 * label and the line under the toolbar say so. A silent client-side sort over a paged list
 * is the more expensive lie: it looks alphabetical, so the contact the user cannot find is
 * assumed not to exist rather than assumed to be on a later page.
 */
const SORT_OPTIONS = [
  { value: 'created', label: 'Oldest first (as paged)' },
  { value: 'name', label: 'Name (within loaded rows)' },
];

/**
 * Three filters, each answerable independently, and none of them a choice *between*
 * customer and vendor. `Any` is the absent parameter rather than `false`, which is a
 * different question the server also answers — "contacts that are not customers".
 */
const TRISTATE_OPTIONS = [
  { value: 'any', label: 'Any' },
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
];

const ACTIVE_OPTIONS = [
  { value: 'any', label: 'Active and inactive' },
  { value: 'yes', label: 'Active only' },
  { value: 'no', label: 'Inactive only' },
];

function toTristate(value: boolean | null): string {
  if (value === null) return 'any';
  return value ? 'yes' : 'no';
}

function fromTristate(value: string): boolean | null {
  if (value === 'yes') return true;
  if (value === 'no') return false;
  return null;
}

export function ContactsScreen(): ReactElement {
  const [filters, setFilters] = useState<ContactFilters>(NO_CONTACT_FILTERS);
  const [sort, setSort] = useState<SortMode>('created');
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Contact | null>(null);
  const [deleting, setDeleting] = useState<Contact | null>(null);

  const list = useContactList(filters);
  const setActive = useSetContactActive();
  const intentKey = useIntentKey();

  const loaded = useMemo(() => list.data?.pages.flatMap((page) => page.items) ?? [], [list.data]);

  const rows = useMemo(() => {
    if (sort === 'created') return loaded;
    /**
     * A copy, and `localeCompare` rather than `<`. This is the user's own directory of
     * names, so it must order the way their locale reads it — and sorting the array
     * TanStack handed back would mutate the cache in place.
     */
    return [...loaded].sort((left, right) => left.displayName.localeCompare(right.displayName));
  }, [loaded, sort]);

  function filter<K extends keyof ContactFilters>(key: K, value: ContactFilters[K]): void {
    setFilters((current) => ({ ...current, [key]: value }));
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold text-text">Contacts</h1>
          <p className="max-w-form text-text-muted">
            Customers, vendors, both, or neither — one row per party, whatever it is to you.
          </p>
        </div>
        <Button
          variant="primary"
          onClick={() => {
            setEditing(null);
            setFormOpen(true);
          }}
        >
          New contact
        </Button>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-surface p-3">
        <Field className="w-40" hint="A contact can match both.">
          <FieldLabel>Customer</FieldLabel>
          <Select
            value={toTristate(filters.isCustomer)}
            options={TRISTATE_OPTIONS}
            onValueChange={(value) => {
              filter('isCustomer', fromTristate(value));
            }}
          />
        </Field>

        <Field className="w-40">
          <FieldLabel>Vendor</FieldLabel>
          <Select
            value={toTristate(filters.isVendor)}
            options={TRISTATE_OPTIONS}
            onValueChange={(value) => {
              filter('isVendor', fromTristate(value));
            }}
          />
        </Field>

        <Field className="w-52">
          <FieldLabel>Status</FieldLabel>
          <Select
            value={toTristate(filters.isActive)}
            options={ACTIVE_OPTIONS}
            onValueChange={(value) => {
              filter('isActive', fromTristate(value));
            }}
          />
        </Field>

        <Field className="w-56">
          <FieldLabel>Order</FieldLabel>
          <Select
            value={sort}
            options={SORT_OPTIONS}
            onValueChange={(value) => {
              setSort(value === 'name' ? 'name' : 'created');
            }}
          />
        </Field>
      </div>

      <p className="text-sm text-text-subtle">
        {sort === 'created'
          ? 'Oldest first by creation, which is how the server pages it. Renaming a contact does not move it.'
          : `Sorted by name across the ${String(rows.length)} contacts loaded so far — a page-local sort. The server pages oldest-first, so a later page can still hold an earlier name.`}
      </p>

      {list.isPending && <p className="text-text-muted">Loading contacts…</p>}

      {list.isError && (
        <ErrorBanner
          error={list.error}
          onRetry={() => {
            void list.refetch();
          }}
        />
      )}

      {list.isSuccess && rows.length === 0 && (
        <p className="rounded-lg border border-border bg-surface p-6 text-center text-text-muted">
          No contacts match these filters.
        </p>
      )}

      {rows.length > 0 && (
        <ResponsiveTable>
          <table className="w-full border-collapse text-base">
            <caption className="sr-only">
              {sort === 'created'
                ? 'Contacts, oldest first by creation'
                : 'Contacts, sorted by name within the rows loaded'}
            </caption>
            <thead>
              <tr className="border-b border-border text-left text-sm text-text-muted">
                <th scope="col" className="py-2 pr-3 font-medium">
                  Code
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Name
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Roles
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Contact
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Status
                </th>
                <th scope="col" className="py-2 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((contact) => (
                <tr key={contact.id} className="border-b border-border align-top">
                  <td className="py-2 pr-3 font-mono text-sm text-text-muted">
                    {contact.code ?? '—'}
                  </td>
                  <td className="py-2 pr-3">
                    <span className="text-text">{contact.displayName}</span>
                    {contact.legalName !== null && (
                      <span className="block text-xs text-text-subtle">{contact.legalName}</span>
                    )}
                  </td>
                  <td className="py-2 pr-3">
                    <Roles contact={contact} />
                  </td>
                  <td className="py-2 pr-3 text-sm text-text-muted">
                    {contact.email ?? contact.phone ?? '—'}
                  </td>
                  <td className="py-2 pr-3 text-sm">
                    {contact.isActive ? (
                      <span className="text-text-muted">Active</span>
                    ) : (
                      <span className="text-warning-text">Inactive</span>
                    )}
                  </td>
                  <td className="py-2">
                    <div className="flex justify-end gap-1">
                      <Button
                        size="sm"
                        aria-label={`Edit ${contact.displayName}`}
                        onClick={() => {
                          setEditing(contact);
                          setFormOpen(true);
                        }}
                      >
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        disabled={setActive.isPending}
                        aria-label={`${contact.isActive ? 'Deactivate' : 'Reactivate'} ${contact.displayName}`}
                        onClick={() => {
                          setActive.mutate({
                            contactId: contact.id,
                            active: !contact.isActive,
                            idempotencyKey: intentKey(
                              `${contact.isActive ? 'deactivate' : 'reactivate'}:${contact.id}`,
                            ),
                          });
                        }}
                      >
                        {contact.isActive ? 'Deactivate' : 'Reactivate'}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Delete ${contact.displayName}`}
                        onClick={() => {
                          setDeleting(contact);
                        }}
                      >
                        Delete
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ResponsiveTable>
      )}

      {setActive.isError && (
        <ErrorBanner
          error={setActive.error}
          onRetry={() => {
            setActive.reset();
          }}
        />
      )}

      {/* The button exists only when the server handed back a cursor. Presence is the only
          signal that more exists — a full page does not imply another — so deriving this
          from the row count would ask for a page that is not there. */}
      {list.hasNextPage && (
        <div>
          <Button
            disabled={list.isFetchingNextPage}
            onClick={() => {
              void list.fetchNextPage();
            }}
          >
            {list.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}

      <ContactFormDialog
        contact={editing}
        open={formOpen}
        onOpenChange={(open) => {
          setFormOpen(open);
          if (!open) setEditing(null);
        }}
      />

      <DeleteContactDialog
        contact={deleting}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      />
    </div>
  );
}

/**
 * Both badges when both, and a named state when neither — not a blank cell.
 *
 * A contact in no subledger is an ordinary contact rather than an incomplete one, so the
 * cell says what it is instead of leaving a gap that reads as missing data.
 */
function Roles({ contact }: { readonly contact: Contact }): ReactElement {
  if (!contact.isCustomer && !contact.isVendor) {
    return (
      <span
        className="text-sm text-text-subtle"
        title="Named on journal lines without taking part in a subledger."
      >
        Neither
      </span>
    );
  }

  return (
    <span className="flex flex-wrap gap-1">
      {contact.isCustomer && <Badge>Customer</Badge>}
      {contact.isVendor && <Badge>Vendor</Badge>}
    </span>
  );
}

function Badge({ children }: { readonly children: string }): ReactElement {
  return (
    <span className="rounded-full border border-border bg-surface-sunken px-2 py-0.5 text-xs text-text-muted">
      {children}
    </span>
  );
}
