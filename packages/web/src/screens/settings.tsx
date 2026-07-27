import type { ReactElement } from 'react';

import { DimensionsSection } from './settings/dimensions';
import { MembersSection } from './settings/members';
import { FiscalPeriodsSection } from './settings/periods';

/**
 * Organization settings (OB-050): the accounting calendar, the reporting axes, and the
 * people.
 *
 * ## Why the three are stacked and not tabbed
 *
 * Fiscal periods are a prerequisite to using the product at all — `journals.period_id` is
 * `NOT NULL` and nothing creates a period as a side effect of posting into it (D-17), so
 * an org with no periods can record nothing. Behind a tab, that fact is one click away
 * from a user who does not know it exists, and the failure they meet instead is a refused
 * journal entry on a different screen. Stacked, with periods first, the prerequisite is
 * the first thing on the page.
 *
 * The three sections each own their own queries and mutations rather than being fed from
 * here. That keeps this file a composition and means a section is testable on its own,
 * which is what the three tests next to them do.
 */
export function SettingsScreen(): ReactElement {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-text">Settings</h1>
        <p className="max-w-prose text-sm text-text-muted">
          The calendar the books are closed over, the axes reports are sliced by, and who may act in
          this organization.
        </p>
      </div>

      <FiscalPeriodsSection />
      <DimensionsSection />
      <MembersSection />
    </div>
  );
}
