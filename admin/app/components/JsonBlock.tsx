import { formatJson, hasJsonContent, jsonPreview } from '@/lib/content';

export default function JsonBlock({
  value,
  summary = 'Raw JSON',
}: {
  value: unknown;
  summary?: string;
}) {
  if (!hasJsonContent(value)) {
    return <span className="muted">-</span>;
  }

  return (
    <details className="json-details">
      <summary>{summary}</summary>
      <pre className="json-block">{formatJson(value)}</pre>
    </details>
  );
}

export function PromptPreview({ value }: { value: unknown }) {
  return <span className="prompt-snippet">{jsonPreview(value)}</span>;
}
