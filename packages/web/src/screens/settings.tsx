import type { ReactElement } from 'react';

import { BrandingSection } from './settings/branding';
import { DimensionsSection } from './settings/dimensions';
import { DiscountAccountsSection } from './settings/discount-accounts';
import { MembersSection } from './settings/members';
import { PaymentTermsSection } from './settings/payment-terms';
import { FiscalPeriodsSection } from './settings/periods';

/**
 * Organization settings (OB-050, OB-131, OB-140): the accounting calendar, the reporting
 * axes, the people, the letterhead invoices are sent under, the payment-terms catalog
 * (D-79), and the early-pay discount account nominations (D-106, D-107).
 *
 * ## Why the sections are stacked and not tabbed
 *
 * Fiscal periods are a prerequisite to using the product at all — `journals.period_id` is
 * `NOT NULL` and nothing creates a period as a side effect of posting into it (D-17), so
 * an org with no periods can record nothing. Behind a tab, that fact is one click away
 * from a user who does not know it exists, and the failure they meet instead is a refused
 * journal entry on a different screen. Stacked, with periods first, the prerequisite is
 * the first thing on the page.
 *
 * Each section owns its own queries and mutations rather than being fed from here. That
 * keeps this file a composition and means a section is testable on its own, which is what
 * the tests next to them do.
 */
export function SettingsScreen(): ReactElement {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-text">Settings</h1>
        <p className="max-w-prose text-sm text-text-muted">
          The calendar the books are closed over, the axes reports are sliced by, who may act in
          this organization, the letterhead its invoices are printed under, the payment terms its
          documents default to, and where an early-pay discount posts.
        </p>
      </div>

      <FiscalPeriodsSection />
      <DimensionsSection />
      <MembersSection />
      <BrandingSection />
      <PaymentTermsSection />
      <DiscountAccountsSection />
    </div>
  );
}
