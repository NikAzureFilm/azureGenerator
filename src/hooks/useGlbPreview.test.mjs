import assert from 'node:assert/strict';
import {
  PREVIEW_REFETCH_INTERVAL_MS,
  getPreviewRefetchInterval,
} from '../utils/previewPolling.ts';

assert.equal(
  getPreviewRefetchInterval({
    hasPreview: false,
    isGenerationActive: false,
  }),
  false,
  'preview polling should not run on inactive history/share pages',
);

assert.equal(
  getPreviewRefetchInterval({
    hasPreview: true,
    isGenerationActive: true,
  }),
  false,
  'preview polling should stop once a preview is available',
);

assert.equal(
  getPreviewRefetchInterval({
    hasPreview: false,
    isGenerationActive: true,
  }),
  PREVIEW_REFETCH_INTERVAL_MS,
  'preview polling should run only while an active generation is waiting for a preview',
);

console.log('useGlbPreview polling tests passed');
