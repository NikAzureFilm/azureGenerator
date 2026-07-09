'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

// Inline API-key manager for one provider secret. Test validates a PASTED key
// against the provider (stored keys can't be read back), Save upserts it as the
// Supabase edge-function secret, Remove deletes it. Mirrors BudgetEditor: POST/
// DELETE → router.refresh() on success, with busy/error state. The key never
// leaves this form except in the request body.
export default function ApiKeyRow({
  provider,
  secretName,
  isSet,
}: {
  provider: string;
  secretName: string;
  isSet: boolean;
}) {
  const router = useRouter();
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const empty = value.trim() === '';

  async function onTest() {
    setError('');
    setNotice('');
    setBusy(true);
    try {
      const res = await fetch('/api/providers/keys/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, apiKey: value }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.ok) {
        setNotice(body.detail ? `valid — ${body.detail}` : 'valid');
      } else {
        setError(body.error ?? 'Test failed');
      }
    } catch {
      setError('Network error');
    } finally {
      setBusy(false);
    }
  }

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setNotice('');
    setBusy(true);
    try {
      const res = await fetch('/api/providers/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, apiKey: value }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.ok) {
        setValue('');
        setNotice(
          'Saved — edge functions pick it up on their next cold start.',
        );
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

  async function onRemove() {
    if (
      !window.confirm(
        `Remove the stored ${secretName}? Edge functions lose it on their next cold start.`,
      )
    ) {
      return;
    }
    setError('');
    setNotice('');
    setBusy(true);
    try {
      const res = await fetch('/api/providers/keys', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.ok) {
        setNotice('Removed — edge functions drop it on their next cold start.');
        router.refresh();
      } else {
        setError(body.error ?? 'Remove failed');
      }
    } catch {
      setError('Network error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="keyrow" onSubmit={onSave}>
      <input
        type="password"
        autoComplete="off"
        placeholder="paste new key"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          // Editing invalidates any prior result — a stale "valid" note must not
          // sit next to a changed key.
          setNotice('');
          setError('');
        }}
        disabled={busy}
        aria-label={`New ${secretName} value`}
      />
      <button
        className="btn"
        type="button"
        onClick={onTest}
        disabled={busy || empty}
      >
        Test
      </button>
      <button className="btn" type="submit" disabled={busy || empty}>
        {busy ? 'Working…' : 'Save'}
      </button>
      <button
        className="btn"
        type="button"
        onClick={onRemove}
        disabled={busy || !isSet}
      >
        Remove
      </button>
      {notice && <span className="ok-note">{notice}</span>}
      {error && <span className="err">{error}</span>}
    </form>
  );
}
