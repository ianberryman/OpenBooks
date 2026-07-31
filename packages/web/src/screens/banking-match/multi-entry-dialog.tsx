import type { ReactElement } from 'react';
import { useMemo, useState } from 'react';

import {
  Button,
  Combobox,
  Field,
  FieldLabel,
  MoneyInput,
  Select,
  formatMoney,
} from '../../components';
import type { SelectOption } from '../../components';
import {
  blankAllocateDocument,
  blankDiscount,
  blankPostEntry,
  canSubmit,
  discountEntryFromSuggestion,
  naturalTargetType,
  remainingMagnitude,
  toClearRequest,
} from './entries';
import type {
  AllocateDocumentDraft,
  DiscountEntryDraft,
  EntryDraft,
  EntryMethod,
  PostEntryDraft,
} from './entries';
import type { Account, BankStatementLine, ClearRequest, Contact, OpenDocument } from './queries';
import { useContactOptions, useDiscountSuggestion, useOpenDocuments } from './queries';
import { MatchRefusal } from './refusal';

/**
 * The multi-entry match editor (OB-140; ROADMAP I2, I3, I4, I7, D-80, D-81, D-106).
 *
 * ## What this generalises, in one line each
 *
 * **Lockbox** (I3) is several `allocate_document` entries, each against a different
 * contact's document, in one request. **Split-coding** (I7, the deferred OB-094) is
 * several `post_entry` entries against different accounts. Both are the same mechanism —
 * an array of entries the line must balance to (E4) — so this is one editor and not two.
 *
 * ## The running difference is the whole UX
 *
 * `remainingMagnitude` (`entries.ts`) is the line's own magnitude minus what has been
 * entered so far. Above zero: the entries fall short and either need more of them or a
 * `differenceAccountId` for the residual (a bank charge, a short payment). Below zero:
 * the entries ask for more than the line moved, which the server refuses exactly as a
 * shortfall does — `assertClearingBalances` treats the two symmetrically (E4), and so does
 * this screen: the difference account field appears whenever the remainder is non-zero in
 * either direction, not only when it is positive.
 *
 * ## The discount affordance is per document, never automatic
 *
 * Once an `allocate_document` entry names a target, `DocumentPicker` asks
 * `useDiscountSuggestion` for that document as of the line's own posted date. A `200`
 * renders "Add suggested discount" — one click appends a `discount` entry pre-filled from
 * the preview; nothing here ever adds it unasked (D-43). A `204` (no term, a simple term,
 * or the window has passed) renders nothing, which is the ordinary case and not a failure.
 */

const METHOD_OPTIONS: readonly SelectOption[] = [
  { value: 'post_entry', label: 'Code to an account' },
  { value: 'allocate_document', label: 'Settle a document' },
  { value: 'discount', label: 'Early-pay discount' },
];

const METHOD_LABEL: Readonly<Record<EntryMethod, string>> = {
  post_entry: 'Code to an account',
  allocate_document: 'Settle a document',
  discount: 'Early-pay discount',
};

/** `given` (expense) for an invoice's discount, `received` (revenue) for a bill's — the
 *  mirror `discount-accounts.ts`'s `REQUIRED_TYPE` enforces server-side. A convenience
 *  narrowing only; the server is the authority on the account's type. */
function discountAccountType(targetType: 'invoice' | 'bill'): 'expense' | 'revenue' {
  return targetType === 'invoice' ? 'expense' : 'revenue';
}

export interface MultiEntryDialogProps {
  readonly line: BankStatementLine;
  readonly accounts: readonly Account[];
  readonly pending: boolean;
  readonly error: unknown;
  readonly onSubmit: (request: ClearRequest) => void;
  readonly onClose: () => void;
}

export function MultiEntryDialog({
  line,
  accounts,
  pending,
  error,
  onSubmit,
  onClose,
}: MultiEntryDialogProps): ReactElement {
  const targetType = naturalTargetType(line.amount);
  const [entries, setEntries] = useState<readonly EntryDraft[]>(() => [
    blankAllocateDocument(targetType),
  ]);
  const [differenceAccountId, setDifferenceAccountId] = useState<string | null>(null);

  const remaining = remainingMagnitude(entries, line.amount);
  const ready = canSubmit(entries, line.amount, differenceAccountId);

  const accountOptions = useMemo(
    () =>
      accounts.map((account) => ({ value: account.id, label: account.name, detail: account.code })),
    [accounts],
  );

  function replaceEntry(key: string, updated: EntryDraft): void {
    setEntries((current) => current.map((entry) => (entry.key === key ? updated : entry)));
  }

  function removeEntry(key: string): void {
    setEntries((current) => current.filter((entry) => entry.key !== key));
  }

  function blankFor(method: EntryMethod): EntryDraft {
    switch (method) {
      case 'post_entry':
        return blankPostEntry();
      case 'allocate_document':
        return blankAllocateDocument(targetType);
      case 'discount':
        return blankDiscount(targetType);
    }
  }

  function addEntry(method: EntryMethod): void {
    setEntries((current) => [...current, blankFor(method)]);
  }

  function changeMethod(key: string, method: EntryMethod): void {
    setEntries((current) =>
      current.map((entry) => (entry.key === key ? { ...blankFor(method), key } : entry)),
    );
  }

  function addDiscount(draft: DiscountEntryDraft): void {
    setEntries((current) => [...current, draft]);
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-text-muted">
        {line.postedDate} · {line.description} ·{' '}
        <span className="font-mono tabular-nums">{formatMoney(line.amount)}</span>
      </p>

      <ul className="flex flex-col gap-3" aria-label="Entries clearing this line">
        {entries.map((entry, index) => (
          <li
            key={entry.key}
            role="group"
            aria-label={`Entry ${String(index + 1)}: ${METHOD_LABEL[entry.method]}`}
            className="rounded-lg border border-border bg-surface-sunken p-3"
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <Field className="w-56">
                <FieldLabel>Method</FieldLabel>
                <Select
                  aria-label={`Method for entry ${String(index + 1)}`}
                  value={entry.method}
                  options={METHOD_OPTIONS}
                  disabled={pending}
                  onValueChange={(value) => {
                    changeMethod(entry.key, value as EntryMethod);
                  }}
                />
              </Field>
              {entries.length > 1 && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  aria-label={`Remove ${METHOD_LABEL[entry.method]} entry`}
                  onClick={() => {
                    removeEntry(entry.key);
                  }}
                >
                  Remove
                </Button>
              )}
            </div>

            {entry.method === 'post_entry' && (
              <PostEntryFields
                entry={entry}
                accountOptions={accountOptions}
                isSole={entries.length === 1}
                disabled={pending}
                onChange={(updated) => {
                  replaceEntry(entry.key, updated);
                }}
              />
            )}
            {entry.method === 'allocate_document' && (
              <AllocateDocumentFields
                entry={entry}
                lineDate={line.postedDate}
                isSole={entries.length === 1}
                disabled={pending}
                onChange={(updated) => {
                  replaceEntry(entry.key, updated);
                }}
                onAddDiscount={addDiscount}
              />
            )}
            {entry.method === 'discount' && (
              <DiscountFields
                entry={entry}
                accounts={accounts}
                disabled={pending}
                onChange={(updated) => {
                  replaceEntry(entry.key, updated);
                }}
              />
            )}
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={pending}
          onClick={() => addEntry('post_entry')}
        >
          Add: code to an account
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={pending}
          onClick={() => addEntry('allocate_document')}
        >
          Add: settle a document
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={pending}
          onClick={() => addEntry('discount')}
        >
          Add: early-pay discount
        </Button>
      </div>

      <RunningDifference
        lineAmount={line.amount}
        remaining={remaining}
        accountOptions={accountOptions}
        differenceAccountId={differenceAccountId}
        onChangeDifferenceAccount={setDifferenceAccountId}
        disabled={pending}
      />

      {error !== undefined && error !== null && <MatchRefusal error={error} />}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={pending}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={!ready || pending}
          onClick={() => {
            onSubmit(toClearRequest(entries, differenceAccountId));
          }}
        >
          {pending ? 'Clearing…' : 'Clear line'}
        </Button>
      </div>
    </div>
  );
}

function PostEntryFields({
  entry,
  accountOptions,
  isSole,
  disabled,
  onChange,
}: {
  readonly entry: PostEntryDraft;
  readonly accountOptions: readonly { value: string; label: string; detail?: string }[];
  readonly isSole: boolean;
  readonly disabled: boolean;
  readonly onChange: (updated: PostEntryDraft) => void;
}): ReactElement {
  return (
    <div className="mt-2 flex flex-wrap items-end gap-3">
      <Field className="w-64">
        <FieldLabel>Account</FieldLabel>
        <Combobox
          value={entry.accountId}
          options={accountOptions}
          disabled={disabled}
          placeholder="Search accounts…"
          onValueChange={(accountId) => {
            onChange({ ...entry, accountId });
          }}
        />
      </Field>
      <Field
        className="w-40"
        hint={isSole ? 'Defaults to the whole of the line if left blank.' : 'Required.'}
      >
        <FieldLabel>Amount</FieldLabel>
        <MoneyInput
          value={entry.amount}
          disabled={disabled}
          onValueChange={(amount) => {
            onChange({ ...entry, amount });
          }}
          {...(isSole ? { placeholder: 'Whole line' } : {})}
        />
      </Field>
    </div>
  );
}

function DocumentPicker({
  targetType,
  contactId,
  targetId,
  disabled,
  onPickContact,
  onPickDocument,
}: {
  readonly targetType: 'invoice' | 'bill';
  readonly contactId: string | null;
  readonly targetId: string | null;
  readonly disabled: boolean;
  readonly onPickContact: (contactId: string | null) => void;
  readonly onPickDocument: (document: OpenDocument | null) => void;
}): ReactElement {
  const contacts = useContactOptions();
  const openDocuments = useOpenDocuments(targetType, contactId);
  const documents = openDocuments.data ?? [];

  const contactOptions = useMemo(
    () =>
      contacts.map((contact: Contact) => ({
        value: contact.id,
        label: contact.displayName,
        ...(contact.code === null ? {} : { detail: contact.code }),
      })),
    [contacts],
  );

  const documentOptions = useMemo(
    () =>
      documents.map((document) => ({
        value: document.id,
        label: document.number,
        detail: formatMoney(document.outstanding),
      })),
    [documents],
  );

  return (
    <div className="flex flex-wrap items-end gap-3">
      <Field className="w-56">
        <FieldLabel>Contact</FieldLabel>
        <Combobox
          value={contactId}
          options={contactOptions}
          disabled={disabled}
          placeholder="Search contacts…"
          onValueChange={onPickContact}
        />
      </Field>
      <Field
        className="w-56"
        hint={
          targetType === 'invoice'
            ? 'Invoices open to this contact.'
            : 'Bills open to this contact.'
        }
      >
        <FieldLabel>{targetType === 'invoice' ? 'Invoice' : 'Bill'}</FieldLabel>
        <Combobox
          value={targetId}
          options={documentOptions}
          disabled={disabled || contactId === null}
          placeholder={contactId === null ? 'Pick a contact first…' : 'Search documents…'}
          emptyMessage="Nothing open for this contact."
          onValueChange={(next) => {
            onPickDocument(documents.find((document) => document.id === next) ?? null);
          }}
        />
      </Field>
    </div>
  );
}

function AllocateDocumentFields({
  entry,
  lineDate,
  isSole,
  disabled,
  onChange,
  onAddDiscount,
}: {
  readonly entry: AllocateDocumentDraft;
  readonly lineDate: string;
  readonly isSole: boolean;
  readonly disabled: boolean;
  readonly onChange: (updated: AllocateDocumentDraft) => void;
  readonly onAddDiscount: (draft: DiscountEntryDraft) => void;
}): ReactElement {
  const suggestion = useDiscountSuggestion(entry.targetType, entry.targetId, lineDate);

  return (
    <div className="mt-2 flex flex-col gap-2">
      <DocumentPicker
        targetType={entry.targetType}
        contactId={entry.contactId}
        targetId={entry.targetId}
        disabled={disabled}
        onPickContact={(contactId) => {
          // One update, not two: a contact change clears the document it invalidates in
          // the same `onChange`, rather than a second call built from the same stale
          // `entry` closure the first call was — which would silently drop whichever of
          // the two changes came second.
          onChange({ ...entry, contactId, targetId: null, outstanding: null });
        }}
        onPickDocument={(document) => {
          onChange({
            ...entry,
            targetId: document?.id ?? null,
            outstanding: document?.outstanding ?? null,
            // Filling the field is a convenience, same as `AllocationEditor`'s "In full" —
            // the operator can still type over it, and nothing here defaults it silently
            // once there is more than one entry (`resolveEntryAmount`'s own refusal).
            amount:
              document !== null && entry.amount === null ? document.outstanding : entry.amount,
          });
        }}
      />
      <div className="flex flex-wrap items-end gap-3">
        <Field
          className="w-40"
          hint={isSole ? 'Defaults to the whole of the line if left blank.' : 'Required.'}
        >
          <FieldLabel>Amount</FieldLabel>
          <MoneyInput
            value={entry.amount}
            disabled={disabled}
            onValueChange={(amount) => {
              onChange({ ...entry, amount });
            }}
            {...(isSole ? { placeholder: 'Whole line' } : {})}
          />
        </Field>
      </div>

      {entry.targetId !== null && suggestion.data !== null && suggestion.data !== undefined && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-accent bg-accent-soft px-3 py-2 text-sm text-text">
          <span>
            Eligible for an early-pay discount of{' '}
            <span className="font-mono tabular-nums">
              {formatMoney(suggestion.data.discountAmountMinor)}
            </span>{' '}
            if settled by {suggestion.data.deadline}.
          </span>
          <Button
            size="sm"
            variant="secondary"
            disabled={disabled}
            onClick={() => {
              const data = suggestion.data;
              if (data === null || data === undefined) return;
              onAddDiscount(discountEntryFromSuggestion(entry.contactId, entry.targetType, data));
            }}
          >
            Add suggested discount
          </Button>
        </div>
      )}
    </div>
  );
}

function DiscountFields({
  entry,
  accounts,
  disabled,
  onChange,
}: {
  readonly entry: DiscountEntryDraft;
  readonly accounts: readonly Account[];
  readonly disabled: boolean;
  readonly onChange: (updated: DiscountEntryDraft) => void;
}): ReactElement {
  const accountOptions = useMemo(
    () =>
      accounts
        .filter((account) => account.type === discountAccountType(entry.targetType))
        .map((account) => ({ value: account.id, label: account.name, detail: account.code })),
    [accounts, entry.targetType],
  );

  return (
    <div className="mt-2 flex flex-col gap-2">
      <DocumentPicker
        targetType={entry.targetType}
        contactId={entry.contactId}
        targetId={entry.targetId}
        disabled={disabled}
        onPickContact={(contactId) => {
          onChange({ ...entry, contactId, targetId: null });
        }}
        onPickDocument={(document) => {
          onChange({ ...entry, targetId: document?.id ?? null });
        }}
      />
      <div className="flex flex-wrap items-end gap-3">
        <Field className="w-64" hint="The discount-given/received account this posts to.">
          <FieldLabel>Discount account</FieldLabel>
          <Combobox
            value={entry.accountId}
            options={accountOptions}
            disabled={disabled}
            placeholder="Search accounts…"
            onValueChange={(accountId) => {
              onChange({ ...entry, accountId });
            }}
          />
        </Field>
        <Field className="w-40" hint="Never the whole of the line.">
          <FieldLabel>Amount</FieldLabel>
          <MoneyInput
            value={entry.amount}
            disabled={disabled}
            onValueChange={(amount) => {
              onChange({ ...entry, amount });
            }}
          />
        </Field>
      </div>
    </div>
  );
}

function RunningDifference({
  lineAmount,
  remaining,
  accountOptions,
  differenceAccountId,
  onChangeDifferenceAccount,
  disabled,
}: {
  readonly lineAmount: string;
  readonly remaining: bigint;
  readonly accountOptions: readonly { value: string; label: string; detail?: string }[];
  readonly differenceAccountId: string | null;
  readonly onChangeDifferenceAccount: (accountId: string | null) => void;
  readonly disabled: boolean;
}): ReactElement {
  const balanced = remaining === 0n;

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-3">
      <p className="text-sm text-text">
        Line: <span className="font-mono tabular-nums">{formatMoney(lineAmount)}</span>
        {' · '}
        {balanced ? (
          <span className="text-success-text">
            Balanced — the entries account for the whole line.
          </span>
        ) : (
          <span className="text-warning-text">
            {remaining > 0n ? 'Short by ' : 'Over by '}
            <span className="font-mono tabular-nums">
              {formatMoney((remaining > 0n ? remaining : -remaining).toString())}
            </span>
            . Add another entry, or name where the difference goes.
          </span>
        )}
      </p>

      {!balanced && (
        <Field
          className="w-64"
          hint="A bank charge or a short payment — E4 requires the difference to be posted."
        >
          <FieldLabel>Difference account</FieldLabel>
          <Combobox
            value={differenceAccountId}
            options={accountOptions}
            disabled={disabled}
            placeholder="Search accounts…"
            onValueChange={onChangeDifferenceAccount}
          />
        </Field>
      )}
    </div>
  );
}
