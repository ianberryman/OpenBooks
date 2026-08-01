import type { ReactElement } from 'react';
import { useState } from 'react';
import { Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';

import { Select } from '../components';
import type { SelectOption } from '../components';
import { cx } from '../lib/cx';
import { Ten99RunDetail } from './run-detail';
import { Ten99RunsList } from './runs-list';
import { Ten99Worksheet } from './worksheet';

/**
 * The 1099 Center (OB-228 Wave-1 Stream D): the worksheet used to review contractor
 * payments before generating, and the filing runs already generated.
 *
 * ## Routing, mirroring `screens/sales.tsx`
 *
 * `/ten99` is the list-shaped home (a tax-year selector plus the Worksheet/Runs tabs) and
 * `/ten99/runs/:runId` is one open run — the same list-and-detail-are-two-routes move
 * `sales.tsx`'s header comment argues for: a run is a link someone can send, a page the
 * browser's Back button returns from, and a URL that survives a refresh. **Expected mount
 * point:** `<Route path="/ten99/*" element={<Ten99CenterScreen />} />` in `App.tsx` — this
 * component owns everything below `/ten99` itself via its own nested `<Routes>`.
 *
 * The tax year is state on the *home* route, not the URL, matching the reports screen's
 * own filter state rather than the document screens' routed id — a tax year is a filter
 * over the worksheet and the runs list, not the identity of a thing being viewed the way a
 * document or a run is.
 */
export function Ten99CenterScreen(): ReactElement {
  return (
    <Routes>
      <Route index element={<Ten99CenterHome />} />
      <Route path="runs/:runId" element={<RunDetailRoute />} />
      {/* A stray path under /ten99 is the center's home, not a 404 — nothing else lives here. */}
      <Route path="*" element={<Navigate to="/ten99" replace />} />
    </Routes>
  );
}

type Ten99Tab = 'worksheet' | 'runs';

const TABS: readonly Ten99Tab[] = ['worksheet', 'runs'];

const TAB_LABEL: Readonly<Record<Ten99Tab, string>> = {
  worksheet: 'Worksheet',
  runs: 'Runs',
};

function currentTaxYear(): number {
  return new Date().getFullYear();
}

/** This year and the three before it. 1099s are almost always filed for a year already
 * closed, so the default below picks the prior year rather than the current one. */
function taxYearOptions(): readonly SelectOption[] {
  const year = currentTaxYear();
  return [year, year - 1, year - 2, year - 3].map((value) => ({
    value: String(value),
    label: String(value),
  }));
}

function Ten99CenterHome(): ReactElement {
  const [taxYear, setTaxYear] = useState(() => currentTaxYear() - 1);
  const [tab, setTab] = useState<Ten99Tab>('worksheet');

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-text">1099 Center</h1>
          <p className="text-text-muted">
            Review what contractors were paid in cash this year, then generate and file 1099s.
          </p>
        </div>

        <div className="flex-1" />

        <div className="w-32">
          <Select
            aria-label="Tax year"
            value={String(taxYear)}
            options={taxYearOptions()}
            onValueChange={(value) => {
              setTaxYear(Number(value));
            }}
          />
        </div>
      </div>

      <div role="tablist" aria-label="1099 Center" className="flex gap-6 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={t === tab}
            onClick={() => {
              setTab(t);
            }}
            className={cx(
              '-mb-px border-b-2 px-1 pb-2 text-sm font-medium transition-colors',
              t === tab
                ? 'border-text text-text'
                : 'border-transparent text-text-muted hover:text-text',
            )}
          >
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>

      {tab === 'worksheet' ? <Ten99Worksheet taxYear={taxYear} /> : <Ten99RunsList />}
    </div>
  );
}

function RunDetailRoute(): ReactElement {
  const navigate = useNavigate();
  const { runId } = useParams();

  if (runId === undefined) return <Navigate to="/ten99" replace />;

  return <Ten99RunDetail runId={runId} onBack={() => void navigate('/ten99')} />;
}
