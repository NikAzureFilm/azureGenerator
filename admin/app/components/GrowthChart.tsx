import { num, shortDate } from '@/lib/format';
import type { GrowthWeekly } from '@/lib/metrics';

function shouldShowAxisLabel(index: number, total: number, maxLabels = 5) {
  if (total <= maxLabels) return true;
  const step = Math.max(1, Math.round((total - 1) / (maxLabels - 1)));
  return index === 0 || index === total - 1 || index % step === 0;
}

export default function GrowthChart({ data }: { data: GrowthWeekly[] }) {
  const max = Math.max(
    1,
    ...data.map((entry) => Math.max(entry.signups, entry.active_users)),
  );
  const latest = data.at(-1);
  const averageSignups =
    data.length > 0
      ? Math.round(
          data.reduce((sum, entry) => sum + entry.signups, 0) / data.length,
        )
      : 0;
  const averageActives =
    data.length > 0
      ? Math.round(
          data.reduce((sum, entry) => sum + entry.active_users, 0) /
            data.length,
        )
      : 0;

  return (
    <div className="card">
      <div className="label">Weekly acquisition vs active users</div>
      <div className="chart-summary">
        <div className="chart-stat">
          <span className="muted">Latest week</span>
          <span className="mono">{latest ? shortDate(latest.week) : '-'}</span>
        </div>
        <div className="chart-stat">
          <span className="muted">Signups</span>
          <span className="mono">{num(latest?.signups ?? 0)}</span>
        </div>
        <div className="chart-stat">
          <span className="muted">Active users</span>
          <span className="mono">{num(latest?.active_users ?? 0)}</span>
        </div>
        <div className="chart-stat">
          <span className="muted">New subs</span>
          <span className="mono">{num(latest?.new_subscriptions ?? 0)}</span>
        </div>
        <div className="chart-stat">
          <span className="muted">Avg weekly signups</span>
          <span className="mono">{num(averageSignups)}</span>
        </div>
        <div className="chart-stat">
          <span className="muted">Avg weekly actives</span>
          <span className="mono">{num(averageActives)}</span>
        </div>
      </div>

      <div className="chart chart-grid">
        {data.map((entry) => {
          const signupsHeight = (entry.signups / max) * 100;
          const activeHeight = (entry.active_users / max) * 100;

          return (
            <div
              key={entry.week}
              className="bar-col paired-bars"
              title={`Week of ${entry.week}\nSignups: ${entry.signups}\nActive: ${entry.active_users}\nNew subs: ${entry.new_subscriptions}`}
            >
              <div
                className="bar"
                style={{
                  height: `${signupsHeight}%`,
                  background: '#5b8cff',
                  flex: 1,
                }}
              />
              <div
                className="bar"
                style={{
                  height: `${activeHeight}%`,
                  background: '#3fb950',
                  flex: 1,
                }}
              />
            </div>
          );
        })}
      </div>

      <div className="chart-axis" aria-hidden="true">
        {data.map((entry, index) => (
          <span key={entry.week}>
            {shouldShowAxisLabel(index, data.length)
              ? shortDate(entry.week)
              : ''}
          </span>
        ))}
      </div>

      <div className="chart-legend">
        <span>
          <span className="dot" style={{ background: '#5b8cff' }} />
          Signups
        </span>
        <span>
          <span className="dot" style={{ background: '#3fb950' }} />
          Active users
        </span>
      </div>
    </div>
  );
}
