// Colored pill for a generation status (success / failure / pending).
// Extracted from app/page.tsx so every page can reuse it.
export default function StatusBadge({ status }: { status: string }) {
  const cls =
    status === 'success'
      ? 'success'
      : status === 'failure'
        ? 'failure'
        : 'pending';
  return <span className={`badge ${cls}`}>{status}</span>;
}
