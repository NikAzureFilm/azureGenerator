import type { GrowthWeekly } from '@/lib/metrics';

// Dependency-free weekly growth chart: signups and active users side by side,
// one pair of bars per ISO week. Pure server markup.
export default function GrowthChart({ data }: { data: GrowthWeekly[] }) {
  const max = Math.max(
    1,
    ...data.map((d) => Math.max(d.signups, d.active_users)),
  );

  return (
    <div className="card">
      <div className="label">
        Signups & active users per week (last {data.length} weeks)
      </div>
      <div className="chart">
        {data.map((d) => {
          const sH = (d.signups / max) * 100;
          const aH = (d.active_users / max) * 100;
          return (
            <div
              key={d.week}
              className="bar-col"
              style={{ flexDirection: 'row', gap: 2 }}
              title={`Week of ${d.week}\nSignups: ${d.signups}\nActive: ${d.active_users}\nNew subs: ${d.new_subscriptions}`}
            >
              <div
                className="bar"
                style={{ height: `${sH}%`, background: '#5b8cff', flex: 1 }}
              />
              <div
                className="bar"
                style={{ height: `${aH}%`, background: '#3fb950', flex: 1 }}
              />
            </div>
          );
        })}
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
