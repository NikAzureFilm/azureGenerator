import { num, shortDate } from '@/lib/format';
import type { DailyActivity } from '@/lib/metrics';

function shouldShowAxisLabel(index: number, total: number, maxLabels = 7) {
  if (total <= maxLabels) return true;
  const step = Math.max(1, Math.round((total - 1) / (maxLabels - 1)));
  return index === 0 || index === total - 1 || index % step === 0;
}

export default function ActivityChart({ data }: { data: DailyActivity[] }) {
  const totals = data.map(
    (entry) => entry.cad_jobs + entry.meshes + entry.images,
  );
  const max = Math.max(1, ...totals);
  const latest = data.at(-1);
  const trailing7 = data.slice(-7);
  const trailing30 = data.slice(-30);
  const trailing7Total = trailing7.reduce(
    (sum, entry) => sum + entry.cad_jobs + entry.meshes + entry.images,
    0,
  );
  const totalGenerations = totals.reduce((sum, total) => sum + total, 0);
  const averagePerDay =
    data.length > 0 ? Math.round(totalGenerations / data.length) : 0;
  const peak = data.reduce<DailyActivity | null>((currentPeak, entry) => {
    if (!currentPeak) return entry;
    const peakTotal =
      currentPeak.cad_jobs + currentPeak.meshes + currentPeak.images;
    const nextTotal = entry.cad_jobs + entry.meshes + entry.images;
    return nextTotal > peakTotal ? entry : currentPeak;
  }, null);
  const tokens30d = trailing30.reduce(
    (sum, entry) => sum + entry.tokens_consumed,
    0,
  );

  return (
    <div className="card">
      <div className="label">Generation mix by day</div>
      <div className="chart-summary">
        <div className="chart-stat">
          <span className="muted">Last day</span>
          <span className="mono">{latest ? shortDate(latest.day) : '-'}</span>
        </div>
        <div className="chart-stat">
          <span className="muted">Jobs last day</span>
          <span className="mono">
            {num(latest ? latest.cad_jobs + latest.meshes + latest.images : 0)}
          </span>
        </div>
        <div className="chart-stat">
          <span className="muted">Last 7d volume</span>
          <span className="mono">{num(trailing7Total)}</span>
        </div>
        <div className="chart-stat">
          <span className="muted">Avg per day</span>
          <span className="mono">{num(averagePerDay)}</span>
        </div>
        <div className="chart-stat">
          <span className="muted">Peak day</span>
          <span className="mono">{peak ? shortDate(peak.day) : '-'}</span>
        </div>
        <div className="chart-stat">
          <span className="muted">Tokens last 30d</span>
          <span className="mono">{num(tokens30d)}</span>
        </div>
      </div>

      <div className="chart chart-grid">
        {data.map((entry) => {
          const total = entry.cad_jobs + entry.meshes + entry.images;
          const height = (total / max) * 100;
          const cadHeight = total ? (entry.cad_jobs / total) * height : 0;
          const meshHeight = total ? (entry.meshes / total) * height : 0;
          const imageHeight = total ? (entry.images / total) * height : 0;

          return (
            <div
              key={entry.day}
              className="bar-col"
              title={`${entry.day}\nCAD: ${entry.cad_jobs}  Mesh: ${entry.meshes}  Img: ${entry.images}\nSignups: ${entry.signups}  Tokens: ${entry.tokens_consumed}`}
            >
              <div
                className="bar"
                style={{ height: `${cadHeight}%`, background: '#5b8cff' }}
              />
              <div
                className="bar"
                style={{ height: `${meshHeight}%`, background: '#2d6a4f' }}
              />
              <div
                className="bar"
                style={{ height: `${imageHeight}%`, background: '#d29922' }}
              />
            </div>
          );
        })}
      </div>

      <div className="chart-axis" aria-hidden="true">
        {data.map((entry, index) => (
          <span key={entry.day}>
            {shouldShowAxisLabel(index, data.length)
              ? shortDate(entry.day)
              : ''}
          </span>
        ))}
      </div>

      <div className="chart-legend">
        <span>
          <span className="dot" style={{ background: '#5b8cff' }} />
          CAD jobs
        </span>
        <span>
          <span className="dot" style={{ background: '#2d6a4f' }} />
          Meshes
        </span>
        <span>
          <span className="dot" style={{ background: '#d29922' }} />
          Images
        </span>
      </div>
    </div>
  );
}
