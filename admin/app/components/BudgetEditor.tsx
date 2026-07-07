'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

// Inline per-provider monthly budget editor. POSTs to /api/providers/budget and
// refreshes the server component on success. Save writes the entered dollar
// amount; Clear removes the budget (sends null).
export default function BudgetEditor({
  provider,
  currentBudgetUsd,
}: {
  provider: string;
  currentBudgetUsd: number | null;
}) {
  const router = useRouter();
  const [value, setValue] = useState(
    currentBudgetUsd == null ? '' : String(currentBudgetUsd),
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(monthlyBudgetUsd: number | null) {
    setError('');
    setBusy(true);
    try {
      const res = await fetch('/api/providers/budget', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, monthlyBudgetUsd }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.ok) {
        router.refresh();
      } else {
        setError(body.error ?? 'Save failed');
      }
    } catch {
      setError('Network error');
    } finally {
      setBusy(false);
    }
  }

  function onSave(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (trimmed === '') {
      setError('Enter an amount, or use Clear to remove the budget');
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed < 0) {
      setError('Enter a non-negative number');
      return;
    }
    void submit(parsed);
  }

  function onClear() {
    setValue('');
    void submit(null);
  }

  return (
    <form className="budget-editor" onSubmit={onSave}>
      <span className="prefix">Budget $</span>
      <input
        type="number"
        min="0"
        step="1"
        inputMode="decimal"
        placeholder="none"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        disabled={busy}
        aria-label={`Monthly budget for ${provider}`}
      />
      <button className="btn" type="submit" disabled={busy}>
        {busy ? 'Saving…' : 'Save'}
      </button>
      <button
        className="btn"
        type="button"
        onClick={onClear}
        disabled={busy || currentBudgetUsd == null}
      >
        Clear
      </button>
      {error && <span className="err">{error}</span>}
    </form>
  );
}
