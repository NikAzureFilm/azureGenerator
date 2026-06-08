// A single KPI card: label, large mono value, optional sub-line.
// Extracted from app/page.tsx so every page can reuse it.
export default function Kpi({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: React.ReactNode;
}) {
  return (
    <div className="card">
      <div className="label">{label}</div>
      <div className="value mono">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}
