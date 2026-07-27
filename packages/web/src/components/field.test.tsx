import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Field, FieldError, FieldLabel, TextInput } from './field';

/**
 * `Field` exists because the part of a form that is repeatedly got wrong is the wiring,
 * not the styling — and a missing `aria-describedby` looks identical on screen. So the
 * assertions here are the ones a screenshot cannot make: that the ids are minted once and
 * consumed from context, and that a screen writing none of them still gets all of them.
 */
describe('Field', () => {
  it('binds label, control, hint, and error without a screen naming an id', () => {
    render(
      <Field error="Enter an account code." hint="Two to eight characters.">
        <FieldLabel>Code</FieldLabel>
        <TextInput />
      </Field>,
    );

    const input = screen.getByRole('textbox', { name: 'Code' });
    expect(input.id).not.toBe('');
    expect(screen.getByText('Code')).toHaveAttribute('for', input.id);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    /**
     * Error before hint, and the order is load-bearing: a screen reader reads
     * `aria-describedby` in the order given, and the correction matters more than guidance
     * the user has already failed to follow.
     */
    expect(input).toHaveAccessibleDescription('Enter an account code. Two to eight characters.');
  });

  it('marks nothing invalid and describes nothing when there is neither error nor hint', () => {
    render(
      <Field>
        <FieldLabel>Code</FieldLabel>
        <TextInput />
      </Field>,
    );

    const input = screen.getByRole('textbox', { name: 'Code' });
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(input).not.toHaveAttribute('aria-describedby');
  });

  it('describes with the hint alone when the field is valid', () => {
    render(
      <Field hint="Two to eight characters.">
        <FieldLabel>Code</FieldLabel>
        <TextInput />
      </Field>,
    );

    const input = screen.getByRole('textbox', { name: 'Code' });
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(input).toHaveAccessibleDescription('Two to eight characters.');
  });

  /**
   * Two fields on one screen is the common case — the journal-line grid renders one per
   * line. Ids that collided would point every label at the first control, which is a
   * defect only a screen reader or a click on a label would surface.
   */
  it('mints ids per field, so repeated fields do not collide', () => {
    render(
      <>
        <Field error="Required.">
          <FieldLabel>Debit</FieldLabel>
          <TextInput />
        </Field>
        <Field error="Required.">
          <FieldLabel>Credit</FieldLabel>
          <TextInput />
        </Field>
      </>,
    );

    const debit = screen.getByRole('textbox', { name: 'Debit' });
    const credit = screen.getByRole('textbox', { name: 'Credit' });
    expect(debit.id).not.toBe(credit.id);
    expect(debit.getAttribute('aria-describedby')).not.toBe(
      credit.getAttribute('aria-describedby'),
    );
  });

  it('announces the error message itself rather than the region holding it', () => {
    render(<FieldError>Debits and credits must balance.</FieldError>);
    expect(screen.getByRole('alert')).toHaveTextContent('Debits and credits must balance.');
  });

  /**
   * A label with nothing to label is silently useless, so it is a hard error rather than a
   * rendered element. `useFieldControl` is deliberately the opposite — a toolbar select
   * carrying its own `aria-label` belongs to no field — and that asymmetry is the thing
   * worth pinning down.
   */
  it('refuses to render a label outside a Field', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<FieldLabel>Orphan</FieldLabel>)).toThrow(
      '<FieldLabel> must be rendered inside a <Field>.',
    );
    logged.mockRestore();
  });
});
