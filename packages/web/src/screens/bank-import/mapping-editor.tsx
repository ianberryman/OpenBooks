import type { ReactElement } from 'react';

import { Field, FieldLabel, Select } from '../../components';
import { CheckboxField } from './controls';
import type { BankAmountConvention, BankDateOrder, BankImportMappingDefinition } from './queries';

/**
 * The column-mapping editor, and the two domain traps it exists to encode
 * (`packages/shared-types/src/banking/imports.ts`; ROADMAP D-41, D-42).
 *
 * ## The date order is chosen, never inferred
 *
 * `01/02/2026` is a valid date under both `dmy` and `mdy` and means two different months.
 * A detector that guesses from the first rows is right until a statement happens to
 * contain no day above twelve, at which point it silently mis-dates the whole file — and
 * a mis-dated line lands in the wrong reconciliation period, discovered a month later by
 * a reconciliation that will not balance. So this is a control the user sets, with the
 * hint that says why, and not a thing the screen works out.
 *
 * ## The credit column is money *in*
 *
 * Under `debit_credit_columns` the labels are the *bank's* accounting, not the user's.
 * Your account is the bank's liability, so a deposit is a **credit** on their statement
 * and a **debit** in your books — the credit column is the money coming in. The editor
 * states this next to the field rather than leaving the user to discover it by a sign
 * that came out backwards.
 *
 * The editor holds a `MappingDraft` — column assignments that may still be incomplete —
 * and `toDefinition` turns a complete one into the wire shape, enforcing the
 * `amount`-vs-`debit`/`credit` exclusivity the contract refines on.
 */

/** One column the file offers, enumerated from its first line for assignment. */
export interface ColumnOption {
  readonly index: number;
  readonly label: string;
}

/** A field's assignment: the column index it maps to, or `null` when unassigned. */
export interface MappingColumns {
  readonly postedDate: number | null;
  readonly description: number | null;
  readonly amount: number | null;
  readonly debit: number | null;
  readonly credit: number | null;
  readonly valueDate: number | null;
  readonly counterparty: number | null;
  readonly bankReference: number | null;
}

export interface MappingDraft {
  readonly hasHeaderRow: boolean;
  /** The actual delimiter character, one char — a tab is a tab, not `\t` (the contract). */
  readonly delimiter: string;
  readonly dateOrder: BankDateOrder;
  readonly amountConvention: BankAmountConvention;
  readonly columns: MappingColumns;
}

export function initialMappingDraft(): MappingDraft {
  return {
    hasHeaderRow: true,
    delimiter: ',',
    // `ymd` is ISO 8601 and unambiguous, so it is the safe default to land on; the hint
    // still makes the choice conspicuous, because the file — not the default — decides it.
    dateOrder: 'ymd',
    amountConvention: 'signed',
    columns: {
      postedDate: null,
      description: null,
      amount: null,
      debit: null,
      credit: null,
      valueDate: null,
      counterparty: null,
      bankReference: null,
    },
  };
}

const DELIMITERS: readonly { readonly value: string; readonly label: string }[] = [
  { value: ',', label: 'Comma  ,' },
  { value: ';', label: 'Semicolon  ;' },
  { value: '\t', label: 'Tab' },
  { value: '|', label: 'Pipe  |' },
];

const DATE_ORDERS: readonly { readonly value: BankDateOrder; readonly label: string }[] = [
  { value: 'ymd', label: 'Year, month, day  (2026-02-01)' },
  { value: 'dmy', label: 'Day, month, year  (01/02/2026)' },
  { value: 'mdy', label: 'Month, day, year  (02/01/2026)' },
];

const AMOUNT_CONVENTIONS: readonly {
  readonly value: BankAmountConvention;
  readonly label: string;
}[] = [
  { value: 'signed', label: 'One column, signed  (+ in, − out)' },
  { value: 'signed_reversed', label: 'One column, credit-card sign  (a purchase is +)' },
  { value: 'debit_credit_columns', label: 'Separate debit and credit columns' },
];

/**
 * A complete draft as the wire shape, or `null` while it is still incomplete.
 *
 * This is where the contract's refinement is met on the client: `amount` and the
 * `debit`/`credit` pair are mutually exclusive, decided by `amountConvention`, so the
 * unused side is nulled here rather than sent and refused. Returning `null` for an
 * incomplete draft is what disables preview until every required field is assigned.
 */
export function toDefinition(draft: MappingDraft): BankImportMappingDefinition | null {
  const { columns } = draft;
  if (columns.postedDate === null || columns.description === null) return null;

  const debitCredit = draft.amountConvention === 'debit_credit_columns';
  if (debitCredit) {
    if (columns.debit === null || columns.credit === null) return null;
  } else if (columns.amount === null) {
    return null;
  }

  return {
    hasHeaderRow: draft.hasHeaderRow,
    delimiter: draft.delimiter,
    dateOrder: draft.dateOrder,
    amountConvention: draft.amountConvention,
    columns: {
      postedDate: columns.postedDate,
      description: columns.description,
      amount: debitCredit ? null : columns.amount,
      debit: debitCredit ? columns.debit : null,
      credit: debitCredit ? columns.credit : null,
      valueDate: columns.valueDate,
      counterparty: columns.counterparty,
      bankReference: columns.bankReference,
    },
  };
}

interface MappingEditorProps {
  readonly columns: readonly ColumnOption[];
  readonly value: MappingDraft;
  readonly onChange: (draft: MappingDraft) => void;
}

export function MappingEditor({ columns, value, onChange }: MappingEditorProps): ReactElement {
  const debitCredit = value.amountConvention === 'debit_credit_columns';

  function setColumn(field: keyof MappingColumns, index: number | null): void {
    onChange({ ...value, columns: { ...value.columns, [field]: index } });
  }

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-wrap items-end gap-3">
        <CheckboxField
          label="The first row is a header"
          checked={value.hasHeaderRow}
          onCheckedChange={(hasHeaderRow) => {
            onChange({ ...value, hasHeaderRow });
          }}
        />

        <Field className="w-44">
          <FieldLabel>Delimiter</FieldLabel>
          <Select
            value={value.delimiter}
            options={DELIMITERS}
            onValueChange={(delimiter) => {
              onChange({ ...value, delimiter });
            }}
          />
        </Field>

        <Field
          className="w-64"
          hint="Chosen, not detected: 01/02/2026 is a different month under each."
        >
          <FieldLabel>Date order</FieldLabel>
          <Select
            value={value.dateOrder}
            options={DATE_ORDERS}
            onValueChange={(order) => {
              onChange({ ...value, dateOrder: order as BankDateOrder });
            }}
          />
        </Field>

        <Field
          className="w-72"
          hint={
            debitCredit
              ? 'The credit column is money in: the labels are the bank’s, and your account is their liability.'
              : undefined
          }
        >
          <FieldLabel>Amount columns</FieldLabel>
          <Select
            value={value.amountConvention}
            options={AMOUNT_CONVENTIONS}
            onValueChange={(convention) => {
              onChange({ ...value, amountConvention: convention as BankAmountConvention });
            }}
          />
        </Field>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <ColumnSelect
          label="Posted date"
          columns={columns}
          value={value.columns.postedDate}
          onChange={(index) => {
            setColumn('postedDate', index);
          }}
        />
        <ColumnSelect
          label="Description"
          columns={columns}
          value={value.columns.description}
          onChange={(index) => {
            setColumn('description', index);
          }}
        />

        {debitCredit ? (
          <>
            <ColumnSelect
              label="Debit (money out)"
              columns={columns}
              value={value.columns.debit}
              onChange={(index) => {
                setColumn('debit', index);
              }}
            />
            <ColumnSelect
              label="Credit (money in)"
              columns={columns}
              value={value.columns.credit}
              onChange={(index) => {
                setColumn('credit', index);
              }}
            />
          </>
        ) : (
          <ColumnSelect
            label="Amount"
            columns={columns}
            value={value.columns.amount}
            onChange={(index) => {
              setColumn('amount', index);
            }}
          />
        )}

        <ColumnSelect
          label="Value date"
          optional
          columns={columns}
          value={value.columns.valueDate}
          onChange={(index) => {
            setColumn('valueDate', index);
          }}
        />
        <ColumnSelect
          label="Counterparty"
          optional
          columns={columns}
          value={value.columns.counterparty}
          onChange={(index) => {
            setColumn('counterparty', index);
          }}
        />
        <ColumnSelect
          label="Bank reference"
          optional
          hint="The strongest field in the duplicate check (D-42) — map it when the file has one."
          columns={columns}
          value={value.columns.bankReference}
          onChange={(index) => {
            setColumn('bankReference', index);
          }}
        />
      </div>
    </div>
  );
}

const UNASSIGNED = '';

function ColumnSelect({
  label,
  columns,
  value,
  onChange,
  optional = false,
  hint,
}: {
  readonly label: string;
  readonly columns: readonly ColumnOption[];
  readonly value: number | null;
  readonly onChange: (index: number | null) => void;
  readonly optional?: boolean;
  readonly hint?: string;
}): ReactElement {
  const options = [
    ...(optional ? [{ value: UNASSIGNED, label: '— none —' }] : []),
    ...columns.map((column) => ({ value: String(column.index), label: column.label })),
  ];

  return (
    <Field {...(hint === undefined ? {} : { hint })}>
      <FieldLabel>{label}</FieldLabel>
      <Select
        value={value === null ? UNASSIGNED : String(value)}
        placeholder="Choose a column…"
        options={options}
        onValueChange={(next) => {
          onChange(next === UNASSIGNED ? null : Number(next));
        }}
      />
    </Field>
  );
}
