import { describe, expect, it } from 'vitest';

import { selectDueStage } from '../../src/modules/invoicing/dunning/engine';
import type { DueStageCandidate } from '../../src/modules/invoicing/dunning/engine';

/**
 * `selectDueStage` (OB-129): which rung of a dunning ladder fires for one
 * invoice on one date. Pure — no database, no context — exactly the property
 * CLAUDE.md asks the engine's selection logic to be, so the sweep's business
 * rule is asserted independently of the query that gathers its inputs.
 *
 * Imported from `engine.ts` directly and not from the module barrel
 * (`../../src/modules/invoicing`): the barrel re-exports `worker.ts`, whose
 * `registerDailyTask`/`runAsAutomation` (`modules/scheduling`, OB-127) did not
 * exist in this codebase at the time this suite was written, and a value
 * import of a missing module fails at load time for every consumer of the
 * barrel — see `engine.ts`'s header.
 */

interface Stage extends DueStageCandidate {
  readonly label: string;
}

function stage(
  stageNumber: number,
  offsetDays: number,
  label = `stage ${String(stageNumber)}`,
): Stage {
  return { stageNumber, offsetDays, label };
}

describe('selectDueStage', () => {
  it('returns null when no stage has come due', () => {
    const stages = [stage(1, 7), stage(2, 14)];
    expect(selectDueStage(stages, '2026-03-01', '2026-03-05', new Set())).toBeNull();
  });

  it('selects a stage that triggers exactly on the run date', () => {
    const stages = [stage(1, 0)];
    expect(selectDueStage(stages, '2026-03-01', '2026-03-01', new Set())).toEqual(stage(1, 0));
  });

  it('selects a negative-offset (pre-due-date) reminder that has come due', () => {
    const stages = [stage(1, -3)];
    // Due date 2026-03-10, offset -3 → triggers 2026-03-07.
    expect(selectDueStage(stages, '2026-03-10', '2026-03-07', new Set())).toEqual(stage(1, -3));
    expect(selectDueStage(stages, '2026-03-10', '2026-03-06', new Set())).toBeNull();
  });

  it('selects the highest-numbered stage among those due, not the first in the array', () => {
    const stages = [stage(1, 0), stage(3, 7), stage(2, 3)];
    // At 10 days overdue, all three have triggered; stage 3 is the highest.
    const due = selectDueStage(stages, '2026-03-01', '2026-03-11', new Set());
    expect(due).toEqual(stage(3, 7));
  });

  it('skips a stage that has already sent, even if it is the highest due', () => {
    const stages = [stage(1, 0), stage(2, 7)];
    const due = selectDueStage(stages, '2026-03-01', '2026-03-11', new Set([2]));
    expect(due).toEqual(stage(1, 0));
  });

  it('returns null when every due stage has already sent', () => {
    const stages = [stage(1, 0), stage(2, 7)];
    const due = selectDueStage(stages, '2026-03-01', '2026-03-11', new Set([1, 2]));
    expect(due).toBeNull();
  });

  it('returns null for an empty ladder', () => {
    expect(selectDueStage([], '2026-03-01', '2026-03-11', new Set())).toBeNull();
  });

  it('is exact at a month boundary (UTC calendar arithmetic, not millisecond drift)', () => {
    const stages = [stage(1, 2)];
    // Due date 2026-01-30 + 2 days = 2026-02-01.
    expect(selectDueStage(stages, '2026-01-30', '2026-01-31', new Set())).toBeNull();
    expect(selectDueStage(stages, '2026-01-30', '2026-02-01', new Set())).toEqual(stage(1, 2));
  });
});
