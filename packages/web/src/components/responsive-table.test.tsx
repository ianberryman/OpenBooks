import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ResponsiveTable } from './responsive-table';

/**
 * jsdom has no layout, so the scroll itself is OB-055's browser to prove. What is
 * answerable here is the contract the wrapper promises assistive technology: it is
 * focusable so a keyboard can reach the scroll, and it becomes a named region only when a
 * label is given (else it stays an unlabelled, role-less scroller — no region spam).
 */
describe('ResponsiveTable', () => {
  it('wraps its table in a focusable scroll container', () => {
    render(
      <ResponsiveTable>
        <table>
          <tbody>
            <tr>
              <td>cell</td>
            </tr>
          </tbody>
        </table>
      </ResponsiveTable>,
    );
    const scroller = screen.getByText('cell').closest('div');
    expect(scroller).toHaveAttribute('tabindex', '0');
    expect(scroller).toHaveClass('overflow-x-auto');
    // No label given → no region role, so screen readers do not announce a nameless region.
    expect(scroller).not.toHaveAttribute('role');
  });

  it('exposes a named region when given an aria-label', () => {
    render(
      <ResponsiveTable aria-label="Trial balance">
        <table>
          <tbody>
            <tr>
              <td>cell</td>
            </tr>
          </tbody>
        </table>
      </ResponsiveTable>,
    );
    const region = screen.getByRole('region', { name: 'Trial balance' });
    expect(region).toHaveAttribute('tabindex', '0');
  });
});
