import type { ReactElement } from 'react';
import { useState } from 'react';

import { Button, Field, FieldLabel, TextInput, formatMoney } from '../../components';
import type { BankStatementLine } from './queries';
import { MatchRefusal } from './refusal';

/**
 * Undoing a clearing (OB-086).
 *
 * Where the clearing posted a journal, undoing it reverses that journal — never deletes it
 * (D-16) — so the reversal is a dated entry of its own and must fall in an open fiscal
 * period. The date is asked for rather than assumed, because "today" and "the date the line
 * cleared" are both wrong when the period either is now closed: the user has to say which
 * open day the reversal lands on, and a closed one comes back as `period_closed`.
 *
 * Defaults to the line's posted date — the day the money moved — which is usually inside the
 * same open period the clearing was in.
 */
export interface UndoDialogProps {
  readonly line: BankStatementLine;
  readonly pending: boolean;
  readonly error: unknown;
  readonly onSubmit: (date: string, memo: string | null) => void;
  readonly onClose: () => void;
}

export function UndoDialog({
  line,
  pending,
  error,
  onSubmit,
  onClose,
}: UndoDialogProps): ReactElement {
  const [date, setDate] = useState(line.postedDate);
  const [memo, setMemo] = useState('');

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-text-muted">
        {line.postedDate} · {line.description} ·{' '}
        <span className="font-mono tabular-nums">{formatMoney(line.amount)}</span>
      </p>

      <Field hint="The reversal's own entry date. It must fall in an open period — a closed one is refused.">
        <FieldLabel>Reversal date</FieldLabel>
        <TextInput
          type="date"
          value={date}
          onChange={(event) => {
            setDate(event.target.value);
          }}
        />
      </Field>

      <Field hint="Optional. A note kept on the reversal.">
        <FieldLabel>Memo</FieldLabel>
        <TextInput
          value={memo}
          onChange={(event) => {
            setMemo(event.target.value);
          }}
        />
      </Field>

      {error !== undefined && error !== null && <MatchRefusal error={error} />}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="danger"
          disabled={date === '' || pending}
          onClick={() => {
            onSubmit(date, memo === '' ? null : memo);
          }}
        >
          Undo clearing
        </Button>
      </div>
    </div>
  );
}
