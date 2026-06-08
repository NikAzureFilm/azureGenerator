import type { DailyActivity } from '@/lib/metrics';

// Dependency-free stacked bar chart: generations (cad + mesh) per day, with a
// signups overlay legend. Pure server-rendered markup.
export default function ActivityChart({ data }: { data: DailyActivity[] }) {
  const max = Math.max(1, ...data.map((d) => d.cad_jobs + d.meshes + d.images));

  return (
    <div className="card">
      <div className="label">Generations per day (last {data.length} days)</div>
      <div className="chart">
        {data.map((d) => {
          const total = d.cad_jobs + d.meshes + d.images;
          const h = (total / max) * 100;
          const cadH = total ? (d.cad_jobs / total) * h : 0;
          const meshH = total ? (d.meshes / total) * h : 0;
          const imgH = total ? (d.images / total) * h : 0;
          return (
            <div
              key={d.day}
              className="bar-col"
              title={`${d.day}\nCAD: ${d.cad_jobs}  Mesh: ${d.meshes}  Img: ${d.images}\nSignups: ${d.signups}  Tokens: ${d.tokens_consumed}`}
            >
              <div
                className="bar"
                style={{ height: `${cadH}%`, background: '#5b8cff' }}
              />
              <div
                className="bar"
                style={{ height: `${meshH}%`, background: '#2d6a4f' }}
              />
              <div
                className="bar"
                style={{ height: `${imgH}%`, background: '#8957e5' }}
              />
            </div>
          );
        })}
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
          <span className="dot" style={{ background: '#8957e5' }} />
          Images
        </span>
      </div>
    </div>
  );
}
