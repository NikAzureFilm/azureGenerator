import type { CostDaily } from '@/lib/metrics';
import { usdFromDollars } from '@/lib/format';

// Dependency-free daily cost bars. Shows actual provider cost when we have it;
// when actual cost is essentially zero (no provider_usage rows), falls back to
// the token-based estimate so the chart is never blank. Pure server markup.
export default function CostChart({ data }: { data: CostDaily[] }) {
  const actualSum = data.reduce((s, d) => s + (d.actual_cost_usd ?? 0), 0);
  const useActual = actualSum > 0.0001;
  const valueOf = (d: CostDaily) =>
    useActual ? d.actual_cost_usd : d.est_cost_usd;

  const max = Math.max(1e-9, ...data.map(valueOf));
  const color = useActual ? '#5b8cff' : '#8b91a0';

  return (
    <div className="card">
      <div className="label">
        {useActual ? 'Provider cost' : 'Estimated cost'} per day (last{' '}
        {data.length} days)
      </div>
      <div className="chart">
        {data.map((d) => {
          const v = valueOf(d);
          const h = (v / max) * 100;
          return (
            <div
              key={d.day}
              className="bar-col"
              title={`${d.day}\nActual: ${usdFromDollars(
                d.actual_cost_usd ?? 0,
              )}  Est: ${usdFromDollars(d.est_cost_usd)}\nSignups: ${
                d.signups
              }`}
            >
              <div
                className="bar"
                style={{ height: `${h}%`, background: color }}
              />
            </div>
          );
        })}
      </div>
      <div className="chart-legend">
        <span>
          <span className="dot" style={{ background: color }} />
          {useActual
            ? 'Actual provider cost'
            : 'Estimated cost (tokens × $0.01)'}
        </span>
      </div>
    </div>
  );
}
