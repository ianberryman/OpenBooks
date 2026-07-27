import type { ReactElement } from 'react';
import { useId, useState } from 'react';

import {
  Button,
  Combobox,
  Dialog,
  DialogClose,
  DialogContent,
  Field,
  FieldLabel,
  Select,
  TextInput,
} from '../../components';
import type { ComboboxOption, SelectOption } from '../../components';
import type {
  Account,
  AccountType,
  CreateAccountBody,
  NormalBalance,
  UpdateAccountBody,
} from './accounts-api';
import { useIntentKey } from './intent-key';
import { Refusal, preconditionToken } from './refusal';
import {
  ACCOUNT_TYPES,
  ACCOUNT_TYPE_LABELS,
  NORMAL_BALANCES,
  NORMAL_BALANCE_LABELS,
  contraNote,
  isAccountType,
  isContra,
  isNormalBalance,
} from './vocabulary';

/**
 * The create and edit forms, and the delete confirmation.
 *
 * All three are presentational: they own their fields and their idempotency key and know
 * nothing about TanStack Query, which is what lets the tests below drive them without a
 * network. The screen supplies `onSubmit`, `pending`, and whatever the mutation threw.
 *
 * Mounted only while open — the parent renders them conditionally — so a closed form has
 * no state to reset and a reopened one starts from the account it was given.
 */

/**
 * The combobox has no "none" entry of its own and `null` there means "nothing selected",
 * which is not the same statement as "this account is top-level". A sentinel option says
 * the second thing out loud. It cannot collide with a real value: every other option's
 * value is a uuid.
 */
const TOP_LEVEL = 'top-level';

/**
 * The three hierarchy rules, stated where a parent is chosen. Every one of them is
 * enforced on the server (`hierarchy.ts`) and none is checked here — the depth is a
 * restatement of `ACCOUNT_MAX_DEPTH`, which lives in `@openbooks/shared-types` where this
 * package cannot reach it.
 */
const PARENT_HINT =
  'A parent must have the same type as this account, cannot be one of its own descendants, ' +
  'and the chart may be at most six generations deep. Only the accounts loaded so far are ' +
  'offered.';

const TYPE_OPTIONS: readonly SelectOption[] = ACCOUNT_TYPES.map((type) => ({
  value: type,
  label: ACCOUNT_TYPE_LABELS[type],
}));

const NORMAL_BALANCE_OPTIONS: readonly SelectOption[] = NORMAL_BALANCES.map((balance) => ({
  value: balance,
  label: NORMAL_BALANCE_LABELS[balance],
}));

function parentOptions(accounts: readonly Account[], excludeId: string | null): ComboboxOption[] {
  return [
    { value: TOP_LEVEL, label: 'Top level — no parent' },
    ...accounts
      .filter((account) => account.id !== excludeId)
      .map((account) => ({
        value: account.id,
        label: account.name,
        detail: `${account.code} · ${ACCOUNT_TYPE_LABELS[account.type]}`,
      })),
  ];
}

function toWireDescription(text: string): string | null {
  const trimmed = text.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * The note under `normalBalance`, and the reason it is neutral rather than a warning.
 *
 * A contra account — accumulated depreciation, an allowance for doubtful accounts — is an
 * `asset` with a `credit` normal balance, and it is the case the two independent fields
 * exist for. Styling it as a problem would train a user to change the one answer that was
 * right; saying nothing would leave the mis-click indistinguishable from the intent.
 */
function ContraNote({
  type,
  normalBalance,
}: {
  readonly type: AccountType;
  readonly normalBalance: NormalBalance;
}): ReactElement | null {
  if (!isContra(type, normalBalance)) return null;

  return (
    <p className="rounded-md border border-border bg-surface-sunken p-2 text-xs text-text-muted">
      {contraNote(type, normalBalance)}
    </p>
  );
}

export interface CreateAccountDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The accounts loaded so far, offered as parents. */
  readonly accounts: readonly Account[];
  readonly onSubmit: (body: CreateAccountBody, idempotencyKey: string) => void;
  readonly pending: boolean;
  readonly error: unknown;
}

export function CreateAccountDialog({
  open,
  onOpenChange,
  accounts,
  onSubmit,
  pending,
  error,
}: CreateAccountDialogProps): ReactElement {
  const formId = useId();
  const intentKey = useIntentKey();

  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  /**
   * Both `null` at the start, and `type` does not preselect `normalBalance` when it
   * changes. See `CONVENTIONAL_BALANCE` in `vocabulary.ts`: a guessed normal balance is
   * wrong precisely for the accounts where the field decides the sign of a report.
   */
  const [type, setType] = useState<AccountType | null>(null);
  const [normalBalance, setNormalBalance] = useState<NormalBalance | null>(null);
  const [parentAccountId, setParentAccountId] = useState<string | null>(null);
  const [description, setDescription] = useState('');

  const complete =
    code.trim() !== '' && name.trim() !== '' && type !== null && normalBalance !== null;

  function submit(): void {
    if (!complete || type === null || normalBalance === null) return;

    const body: CreateAccountBody = {
      code: code.trim(),
      name: name.trim(),
      type,
      normalBalance,
      parentAccountId,
      description: toWireDescription(description),
    };

    onSubmit(body, intentKey(JSON.stringify(body)));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="New account"
        description="A code cannot be changed afterwards, so it is worth reading twice. Everything else on this form can."
        footer={
          <>
            <DialogClose asChild>
              <Button>Cancel</Button>
            </DialogClose>
            <Button type="submit" form={formId} variant="primary" disabled={!complete || pending}>
              {pending ? 'Creating…' : 'Create account'}
            </Button>
          </>
        }
      >
        <form
          id={formId}
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          {error !== null && error !== undefined && <Refusal error={error} />}

          <Field hint="Unique within the organization, compared case-insensitively. It cannot be changed once the account exists.">
            <FieldLabel>Code</FieldLabel>
            <TextInput
              value={code}
              autoComplete="off"
              className="font-mono"
              onChange={(event) => {
                setCode(event.target.value);
              }}
            />
          </Field>

          <Field>
            <FieldLabel>Name</FieldLabel>
            <TextInput
              value={name}
              autoComplete="off"
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          </Field>

          <Field hint="Which statement the account appears on. It does not decide the normal balance.">
            <FieldLabel>Type</FieldLabel>
            <Select
              value={type}
              options={TYPE_OPTIONS}
              placeholder="Choose a type…"
              onValueChange={(value) => {
                if (isAccountType(value)) setType(value);
              }}
            />
          </Field>

          <Field hint="The side that increases this account. Stored, never derived from the type.">
            <FieldLabel>Normal balance</FieldLabel>
            <Select
              value={normalBalance}
              options={NORMAL_BALANCE_OPTIONS}
              placeholder="Choose a side…"
              onValueChange={(value) => {
                if (isNormalBalance(value)) setNormalBalance(value);
              }}
            />
          </Field>

          {type !== null && normalBalance !== null && (
            <ContraNote type={type} normalBalance={normalBalance} />
          )}

          <Field hint={PARENT_HINT}>
            <FieldLabel>Rolls up into</FieldLabel>
            <Combobox
              value={parentAccountId ?? TOP_LEVEL}
              options={parentOptions(accounts, null)}
              onValueChange={(value) => {
                setParentAccountId(value === null || value === TOP_LEVEL ? null : value);
              }}
            />
          </Field>

          <Field hint="Optional.">
            <FieldLabel>Description</FieldLabel>
            <TextInput
              value={description}
              autoComplete="off"
              onChange={(event) => {
                setDescription(event.target.value);
              }}
            />
          </Field>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export interface EditAccountDialogProps {
  readonly account: Account;
  readonly onOpenChange: (open: boolean) => void;
  readonly accounts: readonly Account[];
  readonly onSubmit: (body: UpdateAccountBody, idempotencyKey: string) => void;
  readonly pending: boolean;
  readonly error: unknown;
}

export function EditAccountDialog({
  account,
  onOpenChange,
  accounts,
  onSubmit,
  pending,
  error,
}: EditAccountDialogProps): ReactElement {
  const formId = useId();
  const intentKey = useIntentKey();

  const [name, setName] = useState(account.name);
  const [type, setType] = useState<AccountType>(account.type);
  const [normalBalance, setNormalBalance] = useState<NormalBalance>(account.normalBalance);
  const [parentAccountId, setParentAccountId] = useState<string | null>(account.parentAccountId);
  const [description, setDescription] = useState(account.description ?? '');

  const nextDescription = toWireDescription(description);

  /**
   * Only what changed, because the body is a patch: an absent field is left alone, and the
   * schema refuses a body with nothing in it at all.
   */
  const patch: UpdateAccountBody = {
    ...(name.trim() === account.name ? {} : { name: name.trim() }),
    ...(type === account.type ? {} : { type }),
    ...(normalBalance === account.normalBalance ? {} : { normalBalance }),
    ...(parentAccountId === account.parentAccountId ? {} : { parentAccountId }),
    ...(nextDescription === account.description ? {} : { description: nextDescription }),
  };

  const changed = Object.keys(patch).length > 0;
  const reclassifies = type !== account.type || normalBalance !== account.normalBalance;
  const postingsLocked = preconditionToken(error) === 'account_has_postings';

  function submit(): void {
    if (!changed || name.trim() === '') return;
    onSubmit(patch, intentKey(JSON.stringify(patch)));
  }

  function revertClassification(): void {
    setType(account.type);
    setNormalBalance(account.normalBalance);
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onOpenChange(false);
      }}
    >
      <DialogContent
        title={`Edit ${account.code}`}
        description="Name and description are labels and change freely. Type and normal balance decide what every report means, so the server refuses them once the account has been posted to."
        footer={
          <>
            <DialogClose asChild>
              <Button>Cancel</Button>
            </DialogClose>
            <Button
              type="submit"
              form={formId}
              variant="primary"
              disabled={!changed || pending || name.trim() === ''}
            >
              {pending ? 'Saving…' : 'Save changes'}
            </Button>
          </>
        }
      >
        <form
          id={formId}
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          {error !== null && error !== undefined && (
            <Refusal error={error}>
              {postingsLocked && reclassifies && (
                <Button size="sm" onClick={revertClassification}>
                  Put the type and normal balance back
                </Button>
              )}
            </Refusal>
          )}

          {/*
            The code sits first, where the field would be, and says why it is not one
            (D-27). A form that simply omitted it would leave the user hunting; one that
            offered it would be a field whose value silently fails to save, since `code` is
            absent from `updateAccountRequestSchema` and sending it is a validation failure
            naming the field.
          */}
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium text-text">Code</p>
            <p className="font-mono text-base text-text">{account.code}</p>
            <p className="text-xs text-text-subtle">
              A code cannot be changed once the account exists. It is the reference other things
              cite — a journal, an export, a filed schedule — so renumbering an account is a
              different account wearing the old one’s history, and it is also the column this list
              is ordered and paged by. To fix a typo, delete this account and create it again; that
              stays possible for as long as nothing has been posted to it.
            </p>
          </div>

          <Field>
            <FieldLabel>Name</FieldLabel>
            <TextInput
              value={name}
              autoComplete="off"
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          </Field>

          <Field hint="Which statement the account appears on. It does not decide the normal balance.">
            <FieldLabel>Type</FieldLabel>
            <Select
              value={type}
              options={TYPE_OPTIONS}
              onValueChange={(value) => {
                if (isAccountType(value)) setType(value);
              }}
            />
          </Field>

          <Field hint="The side that increases this account. Stored, never derived from the type.">
            <FieldLabel>Normal balance</FieldLabel>
            <Select
              value={normalBalance}
              options={NORMAL_BALANCE_OPTIONS}
              onValueChange={(value) => {
                if (isNormalBalance(value)) setNormalBalance(value);
              }}
            />
          </Field>

          <ContraNote type={type} normalBalance={normalBalance} />

          <Field hint={PARENT_HINT}>
            <FieldLabel>Rolls up into</FieldLabel>
            <Combobox
              value={parentAccountId ?? TOP_LEVEL}
              options={parentOptions(accounts, account.id)}
              onValueChange={(value) => {
                setParentAccountId(value === null || value === TOP_LEVEL ? null : value);
              }}
            />
          </Field>

          <Field hint="Clearing this removes the description.">
            <FieldLabel>Description</FieldLabel>
            <TextInput
              value={description}
              autoComplete="off"
              onChange={(event) => {
                setDescription(event.target.value);
              }}
            />
          </Field>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export interface DeleteAccountDialogProps {
  readonly account: Account;
  readonly onOpenChange: (open: boolean) => void;
  readonly onDelete: (idempotencyKey: string) => void;
  readonly onDeactivate: (idempotencyKey: string) => void;
  readonly pending: boolean;
  readonly error: unknown;
}

/**
 * Deletion and deactivation, offered side by side rather than as one control.
 *
 * They are not two spellings of the same thing. Deletion is possible only for an account
 * with no postings, and it removes a piece of configuration that never appeared in the
 * books — including its hold on the code, which `uq_accounts_org_code` keeps reserved even
 * for an inactive row. Deactivation is what remains available afterwards: the account keeps
 * every posting it carries, keeps its code, and can no longer be chosen for new entries.
 *
 * So both are on this dialog from the moment it opens, and the refusal — `precondition
 * _failed` naming `account_has_postings` — does not introduce the alternative, it narrows
 * the choice to the one that was always the other half of it.
 */
export function DeleteAccountDialog({
  account,
  onOpenChange,
  onDelete,
  onDeactivate,
  pending,
  error,
}: DeleteAccountDialogProps): ReactElement {
  const intentKey = useIntentKey();
  const token = preconditionToken(error);
  const deletionRefused = token === 'account_has_postings' || token === 'account_has_children';

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onOpenChange(false);
      }}
    >
      <DialogContent
        title={`Remove ${account.code} — ${account.name}`}
        description="Two different operations, with two different meanings."
        footer={
          <>
            <DialogClose asChild>
              <Button>Cancel</Button>
            </DialogClose>
            {account.isActive && (
              <Button
                disabled={pending}
                onClick={() => {
                  onDeactivate(intentKey(`deactivate:${account.id}`));
                }}
              >
                Deactivate
              </Button>
            )}
            <Button
              variant="danger"
              disabled={pending || deletionRefused}
              onClick={() => {
                onDelete(intentKey(`delete:${account.id}`));
              }}
            >
              Delete permanently
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {error !== null && error !== undefined && (
            <Refusal error={error}>
              {token === 'account_has_postings' && account.isActive && (
                <Button
                  size="sm"
                  disabled={pending}
                  onClick={() => {
                    onDeactivate(intentKey(`deactivate:${account.id}`));
                  }}
                >
                  Deactivate instead
                </Button>
              )}
            </Refusal>
          )}

          <div className="flex flex-col gap-1">
            <p className="text-sm font-semibold text-text">Delete</p>
            <p className="text-sm text-text-muted">
              Permitted only while nothing has been posted to the account. It has then never
              appeared in the books, so removing it restates no report — and it releases the code,
              which stays reserved otherwise. This cannot be undone.
            </p>
          </div>

          <div className="flex flex-col gap-1">
            <p className="text-sm font-semibold text-text">Deactivate</p>
            <p className="text-sm text-text-muted">
              The only removal available to an account that has been posted to. It keeps every entry
              it carries and keeps its code; it simply cannot be chosen for new postings.
              Reactivating it later is one click, so this is not a one-way door.
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
