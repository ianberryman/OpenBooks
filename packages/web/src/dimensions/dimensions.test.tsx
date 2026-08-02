import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { DimensionAxis, DimensionValue } from './axes';
import { valueOnAxis, withAxisValue } from './axes';
import { LineDimensionFields } from './line-dimensions';

const TIMESTAMP = '2026-07-01T00:00:00.000Z';

function value(id: string, dimensionId: string, code: string, isActive = true): DimensionValue {
  return {
    id,
    dimensionId,
    code,
    name: `${code} name`,
    isActive,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

function axis(id: string, code: string, values: DimensionValue[], isActive = true): DimensionAxis {
  return {
    dimension: {
      id,
      code,
      name: `${code} axis`,
      description: null,
      isActive,
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    },
    values,
  };
}

const DEPT = axis('dim-dept', 'DEPT', [
  value('v-sales', 'dim-dept', 'SALES'),
  value('v-ops', 'dim-dept', 'OPS'),
]);
const REGION = axis('dim-region', 'REGION', [value('v-east', 'dim-region', 'EAST')]);

describe('valueOnAxis / withAxisValue', () => {
  it('resolves the value a line carries on an axis, or null', () => {
    expect(valueOnAxis(['v-ops'], DEPT)).toBe('v-ops');
    expect(valueOnAxis(['v-east'], DEPT)).toBeNull();
    expect(valueOnAxis([], DEPT)).toBeNull();
  });

  it('holds at most one value per axis, replacing in place', () => {
    // Setting a value on an axis that already has one replaces it, leaving other axes alone.
    const start: readonly string[] = ['v-sales', 'v-east'];
    const next = withAxisValue(start, DEPT, 'v-ops');
    expect(next).toContain('v-ops');
    expect(next).toContain('v-east');
    expect(next).not.toContain('v-sales');
    expect(next).toHaveLength(2);
  });

  it('clears an axis when given null, leaving other axes', () => {
    expect(withAxisValue(['v-sales', 'v-east'], DEPT, null)).toEqual(['v-east']);
  });

  it('adds a value on an untagged axis', () => {
    expect(withAxisValue(['v-east'], DEPT, 'v-sales')).toEqual(['v-east', 'v-sales']);
  });
});

describe('LineDimensionFields', () => {
  it('renders one picker per active axis', () => {
    render(
      <LineDimensionFields
        axes={[DEPT, REGION]}
        dimensionValueIds={[]}
        index={0}
        disabled={false}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('DEPT axis, line 1')).toBeInTheDocument();
    expect(screen.getByLabelText('REGION axis, line 1')).toBeInTheDocument();
  });

  it('hides an archived axis the line does not already carry, but keeps one it does', () => {
    const archived = axis('dim-old', 'OLD', [value('v-old', 'dim-old', 'OLD', false)], false);
    const { rerender } = render(
      <LineDimensionFields
        axes={[archived]}
        dimensionValueIds={[]}
        index={0}
        disabled={false}
        onChange={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText('OLD axis, line 1')).not.toBeInTheDocument();
    expect(
      screen.getByText('This organization has no reporting dimensions yet.'),
    ).toBeInTheDocument();

    rerender(
      <LineDimensionFields
        axes={[archived]}
        dimensionValueIds={['v-old']}
        index={0}
        disabled={false}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('OLD axis, line 1')).toBeInTheDocument();
  });

  it('distinguishes the loading empty-state from the no-dimensions one', () => {
    render(
      <LineDimensionFields
        axes={[]}
        dimensionValueIds={[]}
        index={0}
        disabled={false}
        isLoading
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText('Loading dimensions…')).toBeInTheDocument();
  });
});
