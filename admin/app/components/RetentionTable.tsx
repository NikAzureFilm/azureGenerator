import { num, pct, shortDate } from '@/lib/format';
import type { CohortRow } from '@/lib/metrics';
import { buildCohortMatrix } from '@/lib/retention';

export default function RetentionTable({ data }: { data: CohortRow[] }) {
  const cohorts = buildCohortMatrix(data);

  if (cohorts.length === 0) {
    return <div className="muted">Not enough data for cohorts yet.</div>;
  }

  const maxOffset = cohorts.reduce((highest, cohort) => {
    const cohortMax = Math.max(0, ...cohort.activeByOffset.keys());
    return Math.max(highest, cohortMax);
  }, 0);
  const offsets = Array.from({ length: maxOffset + 1 }, (_, i) => i);

  const tint = (frac: number) => {
    if (frac <= 0) return 'rgba(139, 145, 160, 0.16)';
    const alpha = Math.min(0.85, 0.16 + frac * 0.7);
    return `rgba(63, 185, 80, ${alpha.toFixed(3)})`;
  };

  return (
    <div className="card retention-table-card">
      <table>
        <thead>
          <tr>
            <th>Cohort</th>
            <th className="right">Users</th>
            <th className="right">Age</th>
            {offsets.map((offset) => (
              <th key={offset} className="right">
                W{offset}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cohorts.map((cohort) => (
            <tr key={cohort.cohortWeek}>
              <td>
                <div className="mono">{shortDate(cohort.cohortWeek)}</div>
                <div className="muted cohort-meta">{cohort.cohortWeek}</div>
              </td>
              <td className="right mono">{num(cohort.cohortSize)}</td>
              <td className="right mono">{cohort.ageWeeks}w</td>
              {offsets.map((offset) => {
                if (offset > cohort.ageWeeks) {
                  return (
                    <td
                      key={offset}
                      className="right cohort future-cell"
                      title="This cohort has not reached this week yet."
                    >
                      -
                    </td>
                  );
                }

                const active = cohort.activeByOffset.get(offset) ?? 0;
                const frac =
                  cohort.cohortSize > 0 ? active / cohort.cohortSize : 0;

                return (
                  <td
                    key={offset}
                    className="right cohort mono"
                    style={{ background: tint(frac) }}
                    title={`W${offset}: ${active} of ${cohort.cohortSize} active`}
                  >
                    {pct(frac)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
