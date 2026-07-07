// Shared token-count formatters. Extracted from CreditsButton so the sidebar
// token widget and the top-bar credits pill render identical numbers.

export function formatCompact(n: number): string {
  if (n >= 1_000_000) {
    const v = n / 1_000_000;
    return `${v >= 10 ? v.toFixed(0) : v.toFixed(1)}M`;
  }
  if (n >= 1_000) {
    const v = n / 1_000;
    return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)}K`;
  }
  return n.toLocaleString();
}

export function formatFull(n: number): string {
  return n.toLocaleString();
}

export function formatPeriodEnd(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
