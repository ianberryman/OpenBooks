import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { DeleteAccountDialog, EditAccountDialog } from './account-dialogs';
import type { UpdateAccountBody } from './accounts-api';
import { account, apiError, hasPostingsError } from './fixtures';

/**
 * The two rules on this screen that a form can get wrong silently.
 *
 * A field that fails to save is worse than one that is not there, and a single "Remove"
 * button is worse than two operations that mean different things — both are failures that
 * look correct in a screenshot, which is why they are asserted here rather than left to
 * OB-055's browser run.
 */
function noop(): void {}

describe('EditAccountDialog', () => {
  it('offers no control for the code, and says where the field would be why (D-27)', () => {
    render(
      <EditAccountDialog
        account={account({ code: '4000', name: 'Sales' })}
        accounts={[]}
        pending={false}
        error={null}
        onOpenChange={noop}
        onSubmit={noop}
      />,
    );

    // The control is absent, not disabled: `code` is not in `updateAccountRequestSchema`
    // at all, so a field for it would be one whose value the server refuses by name.
    expect(screen.queryByRole('textbox', { name: /code/i })).toBeNull();
    expect(screen.queryByRole('combobox', { name: /code/i })).toBeNull();

    // …and the query above is capable of finding a field, which the mutable one proves.
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Sales');

    // The value is still on screen, with the reason it cannot change and the way out.
    expect(screen.getByText('4000')).toBeInTheDocument();
    expect(screen.getByText(/cannot be changed once the account exists/i)).toBeInTheDocument();
    expect(screen.getByText(/delete this account and create it again/i)).toBeInTheDocument();
  });

  it('starts with nothing to save, and enables saving once a label changes', async () => {
    const user = userEvent.setup();
    render(
      <EditAccountDialog
        account={account()}
        accounts={[]}
        pending={false}
        error={null}
        onOpenChange={noop}
        onSubmit={noop}
      />,
    );

    const save = screen.getByRole('button', { name: 'Save changes' });
    // `updateAccountRequestSchema` refuses a body with no fields in it; an enabled button
    // here would spend a round trip to learn that.
    expect(save).toBeDisabled();

    await user.type(screen.getByRole('textbox', { name: 'Name' }), ' (main)');
    expect(save).toBeEnabled();
  });

  it('sends only what changed, under one key that a resubmission reuses', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn<(body: UpdateAccountBody, idempotencyKey: string) => void>();

    render(
      <EditAccountDialog
        account={account({ name: 'Bank' })}
        accounts={[]}
        pending={false}
        error={null}
        onOpenChange={noop}
        onSubmit={onSubmit}
      />,
    );

    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'ing');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(onSubmit).toHaveBeenCalledTimes(2);
    const first = onSubmit.mock.calls[0];
    const second = onSubmit.mock.calls[1];

    expect(first?.[0]).toStrictEqual({ name: 'Banking' });
    expect(second?.[0]).toStrictEqual({ name: 'Banking' });
    // The same intent, pressed twice. A fresh key per attempt is what turns a retry into a
    // second write (`src/api/idempotency.ts`).
    expect(first?.[1]).toBe(second?.[1]);
  });

  it('renders the postings refusal in the server’s own words', () => {
    render(
      <EditAccountDialog
        account={account()}
        accounts={[]}
        pending={false}
        error={hasPostingsError()}
        onOpenChange={noop}
        onSubmit={noop}
      />,
    );

    const refusal = screen.getByRole('alert');
    expect(refusal).toHaveTextContent('Not possible right now');
    expect(refusal).toHaveTextContent(/cannot be deleted/i);
  });

  it('offers to put the classification back when that is what was refused', async () => {
    const user = userEvent.setup();
    const revert = 'Put the type and normal balance back';

    render(
      <EditAccountDialog
        account={account({ type: 'asset', normalBalance: 'debit' })}
        accounts={[]}
        pending={false}
        error={hasPostingsError()}
        onOpenChange={noop}
        onSubmit={noop}
      />,
    );

    // Nothing to revert while the two fields still hold what the account holds.
    expect(screen.queryByRole('button', { name: revert })).toBeNull();

    await user.click(screen.getByRole('combobox', { name: 'Type' }));
    await user.click(screen.getByRole('option', { name: 'Expense' }));
    expect(screen.getByRole('button', { name: revert })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: revert }));
    expect(screen.getByRole('combobox', { name: 'Type' })).toHaveTextContent('Asset');
    expect(screen.queryByRole('button', { name: revert })).toBeNull();
  });

  it('confirms a contra account rather than flagging it', async () => {
    const user = userEvent.setup();
    render(
      <EditAccountDialog
        account={account({ type: 'asset', normalBalance: 'debit' })}
        accounts={[]}
        pending={false}
        error={null}
        onOpenChange={noop}
        onSubmit={noop}
      />,
    );

    expect(screen.queryByText(/contra account/i)).toBeNull();

    await user.click(screen.getByRole('combobox', { name: 'Normal balance' }));
    await user.click(screen.getByRole('option', { name: 'Credit' }));

    const note = screen.getByText(/contra account/i);
    expect(note).toHaveTextContent(/valid setup, not a mistake/i);
    // Neutral, not an error: `role="alert"` is what the refusals use, and a correct entry
    // must not arrive wearing one.
    expect(note.closest('[role="alert"]')).toBeNull();
  });
});

describe('DeleteAccountDialog', () => {
  it('keeps deletion and deactivation as two operations with two meanings', () => {
    render(
      <DeleteAccountDialog
        account={account()}
        pending={false}
        error={null}
        onOpenChange={noop}
        onDelete={noop}
        onDeactivate={noop}
      />,
    );

    expect(screen.getByRole('button', { name: 'Delete permanently' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Deactivate' })).toBeEnabled();

    expect(screen.getByText(/Permitted only while nothing has been posted/i)).toBeInTheDocument();
    expect(
      screen.getByText(/only removal available to an account that has been posted to/i),
    ).toBeInTheDocument();
  });

  it('gives the two operations different keys, and one key per operation across attempts', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    const onDeactivate = vi.fn();

    render(
      <DeleteAccountDialog
        account={account()}
        pending={false}
        error={null}
        onOpenChange={noop}
        onDelete={onDelete}
        onDeactivate={onDeactivate}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Delete permanently' }));
    await user.click(screen.getByRole('button', { name: 'Delete permanently' }));
    await user.click(screen.getByRole('button', { name: 'Deactivate' }));

    const firstDelete: unknown = onDelete.mock.calls[0]?.[0];
    const secondDelete: unknown = onDelete.mock.calls[1]?.[0];
    const deactivate: unknown = onDeactivate.mock.calls[0]?.[0];

    expect(typeof firstDelete).toBe('string');
    expect(secondDelete).toBe(firstDelete);
    // Deactivating is a different request, so replaying the deletion's key would be an
    // `idempotency_key_conflict` rather than a deactivation.
    expect(deactivate).not.toBe(firstDelete);
  });

  it('closes deletion off and points at deactivation once the account has postings', () => {
    const onDeactivate = vi.fn();

    render(
      <DeleteAccountDialog
        account={account()}
        pending={false}
        error={hasPostingsError()}
        onOpenChange={noop}
        onDelete={noop}
        onDeactivate={onDeactivate}
      />,
    );

    expect(screen.getByRole('button', { name: 'Delete permanently' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent(/Deactivate it instead/i);
    expect(screen.getByRole('button', { name: 'Deactivate instead' })).toBeEnabled();
  });

  it('reports a parent that still has children without offering deletion again', () => {
    render(
      <DeleteAccountDialog
        account={account()}
        pending={false}
        error={apiError(
          412,
          'precondition_failed',
          'This account is a parent in the chart of accounts and cannot be deleted while ' +
            'anything rolls up into it.',
          { precondition: 'account_has_children' },
        )}
        onOpenChange={noop}
        onDelete={noop}
        onDeactivate={noop}
      />,
    );

    expect(screen.getByRole('button', { name: 'Delete permanently' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent(/anything rolls up into it/i);
    // Deactivation is not the remedy for this one — re-parenting the children is — so the
    // refusal must not grow a button that does something else.
    expect(screen.queryByRole('button', { name: 'Deactivate instead' })).toBeNull();
  });

  it('offers no deactivation for an account that is already inactive', () => {
    render(
      <DeleteAccountDialog
        account={account({ isActive: false })}
        pending={false}
        error={null}
        onOpenChange={noop}
        onDelete={noop}
        onDeactivate={noop}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Deactivate' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Delete permanently' })).toBeEnabled();
  });
});
