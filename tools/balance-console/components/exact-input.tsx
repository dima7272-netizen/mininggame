'use client';

import { useState } from 'react';
import { formatExact } from '@/lib/analytics';

export function ExactInput({
  value,
  onCommit,
  label,
  compact = false,
}: {
  value: string;
  onCommit: (value: string) => void;
  label: string;
  compact?: boolean;
}) {
  const [state, setState] = useState({ source: value, draft: value, invalid: false });
  const draft = state.source === value ? state.draft : value;
  const invalid = state.source === value ? state.invalid : false;

  const commit = () => {
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(draft)) {
      setState({ source: value, draft, invalid: true });
      return;
    }
    setState({ source: draft, draft, invalid: false });
    onCommit(draft);
  };
  const formatted = (() => {
    try { return formatExact(value).short; } catch { return value; }
  })();

  return (
    <label className={compact ? 'exact-input compact' : 'exact-input'} title={`Точное значение: ${value}`}>
      <input
        aria-label={label}
        className={invalid ? 'invalid' : ''}
        inputMode="decimal"
        value={draft}
        onBlur={commit}
        onChange={(event) => setState({ source: value, draft: event.target.value, invalid: false })}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
          if (event.key === 'Escape') { setState({ source: value, draft: value, invalid: false }); event.currentTarget.blur(); }
        }}
      />
      {!compact && <small>{formatted}</small>}
    </label>
  );
}
