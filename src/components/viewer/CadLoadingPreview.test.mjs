import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const previewPath = new URL('./CadLoadingPreview.tsx', import.meta.url);
const cadJobPreviewSource = readFileSync(
  new URL('./CadJobPreview.tsx', import.meta.url),
  'utf8',
);

assert.equal(
  existsSync(previewPath),
  true,
  'CAD generation should have a reusable loading preview',
);

const previewSource = readFileSync(previewPath, 'utf8');

assert.match(
  previewSource,
  /import \{ GlbPreview \} from '\.\/GlbPreview';/,
  'CAD loading preview should reuse the same interactive point-cloud mark as mesh generation',
);

assert.match(
  previewSource,
  /data-testid="cad-loading-preview"/,
  'CAD loading preview should expose a stable test hook for rendered validation',
);

assert.match(
  previewSource,
  /<GlbPreview[\s\S]*startTime=\{startTime\}[\s\S]*\/>/,
  'CAD loading preview should render the spinnable AzureFilm letter while waiting',
);

assert.match(
  previewSource,
  /relative flex h-full max-h-dvh w-full flex-col items-center justify-center gap-2/,
  'CAD loading preview should use the same full-size loading shell as mesh generation',
);

assert.doesNotMatch(
  previewSource,
  /glbBlob=/,
  'CAD loading preview should keep the AzureFilm letter visible instead of waiting on a mesh blob',
);

assert.match(
  cadJobPreviewSource,
  /<CadLoadingPreview[\s\S]*generationId=\{cadJob\.id\}[\s\S]*\/>/,
  'pending CAD previews should render the CAD loading preview with a per-job start time',
);
