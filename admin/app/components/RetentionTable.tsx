import type { CohortRow } from '@/lib/metrics';
import { pct, num } from '@/lib/format';

// Pivots long-form cohort rows into a retention triangle. Each cell is the
// share of the cohort that was active that many weeks after signup, tinted by
// retention (greener = higher). Pure server markup.
export default function RetentionTable({ data }: { data: CohortRow[] }) {
  if (data.length === 0) {
    return <div className="muted">Not enough data for cohorts yet.</div>;
  }

  // Group rows by cohort week, capturing the cohort size and an offset→active map.
  const cohorts = new Map<
    string,
    { size: number; active: Map<number, number> }
  >();
  let maxOffset = 0;
  for (const r of data) {
    let c = cohorts.get(r.cohort_week);
    if (!c) {
      c = { size: r.cohort_size, active: new Map() };
      cohorts.set(r.cohort_week, c);
    }
    c.active.set(r.week_offset, r.active);
    if (r.week_offset > maxOffset) maxOffset = r.week_offset;
  }

  const weeks = Array.from(cohorts.keys()).sort();
  const offsets = Array.from({ length: maxOffset + 1 }, (_, i) => i);

  // Tint a cell green-ish by retention fraction (0 → transparent, 1 → solid).
  const tint = (frac: number) => {
    const a = Math.min(0.85, Math.max(0.05, frac));
    return `rgba(63, 185, 80, ${a.toFixed(3)})`;
  };

  return (
    <div className="card" style={{ padding: 6, overflowX: 'auto' }}>
      <table>
        <thead>
          <tr>
            <th>Cohort</th>
            <th className="right">Users</th>
            {offsets.map((o) => (
              <th key={o} className="right">
                W{o}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((w) => {
            const c = cohorts.get(w)!;
            return (
              <tr key={w}>
                <td className="mono">{w}</td>
                <td className="right mono">{num(c.size)}</td>
                {offsets.map((o) => {
                  const active = c.active.get(o);
                  if (active === undefined) {
                    return <td key={o} className="right cohort muted-cell" />;
                  }
                  const frac = c.size > 0 ? active / c.size : 0;
                  return (
                    <td
                      key={o}
                      className="right cohort mono"
                      style={{ background: tint(frac) }}
                      title={`${active} of ${c.size} active`}
                    >
                      {pct(frac)}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
