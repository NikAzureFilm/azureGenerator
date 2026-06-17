export function usd(cents: number): string {
  return (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
  });
}

export function usdFromDollars(dollars: number): string {
  return dollars.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  });
}

export function num(n: number): string {
  return (n ?? 0).toLocaleString('en-US');
}

export function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

// USD with enough precision for sub-cent unit costs (e.g. cost per call).
export function usdSmall(dollars: number): string {
  if (!dollars) return '$0';
  if (Math.abs(dollars) >= 1) return usdFromDollars(dollars);
  const text = dollars.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  return `$${text}`;
}

// Absolute timestamp in UTC, for correlating with logs (server-rendered, so
// a fixed timezone beats the server's locale).
export function absoluteTime(iso: string): string {
  return `${new Date(iso).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}

export function relativeTime(iso: string): string {
  const d = new Date(iso).getTime();
  const diff = Date.now() - d;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function shortDate(iso: string): string {
  return new Date(`${iso}T00:00:00.000Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}
