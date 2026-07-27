import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ApplyTemplateDialog } from './apply-template-dialog';
import type { ChartTemplateSummary } from './accounts-api';
import { templateCollisionError } from './fixtures';

/**
 * The collision is the error worth building for (D-23): it is what a user hits precisely
 * when they have already made an account, and the server refuses the template *whole* and
 * names every code. Rendering that as a generic 409 would tell someone "something already
 * occupies this value" about sixty-five accounts at once.
 */
const TEMPLATES: readonly ChartTemplateSummary[] = [
  {
    id: 'general_small_business',
    name: 'General small business',
    description: 'A conventional chart for a trading or services business.',
    accountCount: 65,
  },
];

function noop(): void {}

describe('ApplyTemplateDialog', () => {
  it('requires a choice before it will apply anything', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();

    render(
      <ApplyTemplateDialog
        templates={TEMPLATES}
        loading={false}
        loadError={null}
        pending={false}
        error={null}
        onOpenChange={noop}
        onApply={onApply}
      />,
    );

    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();

    await user.click(screen.getByRole('radio', { name: /General small business/ }));
    await user.click(screen.getByRole('button', { name: 'Apply' }));

    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0]?.[0]).toBe('general_small_business');
    expect(typeof onApply.mock.calls[0]?.[1]).toBe('string');
  });

  it('says how many accounts a chart contains, and does not preview them', () => {
    render(
      <ApplyTemplateDialog
        templates={TEMPLATES}
        loading={false}
        loadError={null}
        pending={false}
        error={null}
        onOpenChange={noop}
        onApply={noop}
      />,
    );

    expect(screen.getByText('65 accounts')).toBeInTheDocument();
    expect(screen.getByText(/no link back to the template/i)).toBeInTheDocument();
  });

  it('names every colliding code, and says nothing was created', () => {
    render(
      <ApplyTemplateDialog
        templates={TEMPLATES}
        loading={false}
        loadError={null}
        pending={false}
        error={templateCollisionError(['1000', '1100', '4000'])}
        onOpenChange={noop}
        onApply={noop}
      />,
    );

    const refusal = screen.getByRole('alert');
    // The server's own message, not the code table's fallback: a conflict is one of the
    // two codes where the specific message *is* the content (`presentApiError`).
    expect(refusal).toHaveTextContent(/already uses 3 of the account codes/i);

    const codes = within(refusal).getByRole('list', { name: 'Account codes already in use' });
    expect(
      within(codes)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toStrictEqual(['1000', '1100', '4000']);

    expect(refusal).toHaveTextContent(/Nothing was created/i);
    expect(refusal).toHaveTextContent(/copied whole or not at all/i);
  });

  it('renders a collision with one code without pluralising it', () => {
    render(
      <ApplyTemplateDialog
        templates={TEMPLATES}
        loading={false}
        loadError={null}
        pending={false}
        error={templateCollisionError(['1000'])}
        onOpenChange={noop}
        onApply={noop}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent(
      /Delete or renumber the 1 account above and/i,
    );
  });
});
