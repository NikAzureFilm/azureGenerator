'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type Result = {
  applied_amount: number;
  balance_subscription: number;
  balance_purchased: number;
};

// Manual token credit/debit panel for the user detail page. The UI keeps the
// amount positive and a credit/debit radio decides the sign; a confirm step
// guards debits. POSTs to /api/users/:id/tokens (admin_adjust_tokens RPC).
export default function TokenAdjust({ userId }: { userId: string }) {
  const router = useRouter();
  const [amount, setAmount] = useState('');
  const [direction, setDirection] = useState<'credit' | 'debit'>('credit');
  const [source, setSource] = useState<'subscription' | 'purchased'>(
    'purchased',
  );
  const [note, setNote] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<Result | null>(null);

  function validate(): number | null {
    const magnitude = Number(amount.trim());
    if (!Number.isInteger(magnitude) || magnitude <= 0) {
      setError('Enter a positive whole number of tokens');
      return null;
    }
    if (magnitude > 100000) {
      setError('Amount must be 100000 or less');
      return null;
    }
    if (!note.trim()) {
      setError('A note is required');
      return null;
    }
    if (note.length > 200) {
      setError('Note must be 200 characters or fewer');
      return null;
    }
    return direction === 'debit' ? -magnitude : magnitude;
  }

  async function send(signed: number) {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/users/${userId}/tokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: signed, source, note: note.trim() }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.ok) {
        setResult({
          applied_amount: Number(body.applied_amount ?? 0),
          balance_subscription: Number(body.balance_subscription ?? 0),
          balance_purchased: Number(body.balance_purchased ?? 0),
        });
        setAmount('');
        setNote('');
        router.refresh();
      } else {
        setError(body.error ?? 'Adjustment failed');
      }
    } catch {
      setError('Network error');
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setResult(null);
    const signed = validate();
    if (signed == null) return;
    if (signed < 0 && !confirming) {
      // Debits need an explicit confirm step.
      setConfirming(true);
      return;
    }
    void send(signed);
  }

  return (
    <div className="card">
      <div className="label">Adjust token balance</div>
      <form className="token-adjust" onSubmit={onSubmit}>
        <div className="token-adjust-row">
          <label>
            <span className="k">Amount</span>
            <input
              type="number"
              min="1"
              step="1"
              inputMode="numeric"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                setConfirming(false);
              }}
              disabled={busy}
            />
          </label>

          <div className="token-adjust-radios">
            <label>
              <input
                type="radio"
                name="direction"
                checked={direction === 'credit'}
                onChange={() => {
                  setDirection('credit');
                  setConfirming(false);
                }}
                disabled={busy}
              />
              <span>Credit</span>
            </label>
            <label>
              <input
                type="radio"
                name="direction"
                checked={direction === 'debit'}
                onChange={() => {
                  setDirection('debit');
                  setConfirming(false);
                }}
                disabled={busy}
              />
              <span>Debit</span>
            </label>
          </div>

          <label>
            <span className="k">Source</span>
            <select
              className="select"
              value={source}
              onChange={(e) =>
                setSource(e.target.value as 'subscription' | 'purchased')
              }
              disabled={busy}
            >
              <option value="purchased">Purchased</option>
              <option value="subscription">Subscription</option>
            </select>
          </label>
        </div>

        <label className="token-adjust-note">
          <span className="k">Note (required, ≤ 200 chars)</span>
          <input
            type="text"
            maxLength={200}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Reason for this adjustment"
            disabled={busy}
          />
        </label>

        {confirming ? (
          <div className="token-adjust-confirm">
            <span className="down">
              Debit {amount} {source} token(s)? This reduces the user&apos;s
              balance.
            </span>
            <button className="btn" type="submit" disabled={busy}>
              {busy ? 'Applying…' : 'Confirm debit'}
            </button>
            <button
              className="btn"
              type="button"
              onClick={() => setConfirming(false)}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
        ) : (
          <button className="btn" type="submit" disabled={busy}>
            {busy ? 'Applying…' : 'Apply adjustment'}
          </button>
        )}

        {error && <div className="error-inline">{error}</div>}
        {result && (
          <div className="token-adjust-result">
            Applied{' '}
            <b>
              {result.applied_amount > 0 ? '+' : ''}
              {result.applied_amount}
            </b>{' '}
            tokens · subscription <b>{result.balance_subscription}</b> ·
            purchased <b>{result.balance_purchased}</b>
          </div>
        )}
      </form>
    </div>
  );
}
