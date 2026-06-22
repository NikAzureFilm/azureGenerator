export const PREVIEW_REFETCH_INTERVAL_MS = 3000;

export function getPreviewRefetchInterval({
  hasPreview,
  isGenerationActive,
}: {
  hasPreview: boolean;
  isGenerationActive: boolean;
}) {
  return isGenerationActive && !hasPreview
    ? PREVIEW_REFETCH_INTERVAL_MS
    : false;
}
