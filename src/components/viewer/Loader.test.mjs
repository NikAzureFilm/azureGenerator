import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./Loader.tsx', import.meta.url), 'utf8');

assert.match(
  source,
  /import \{ GlbPreview \} from '\.\/GlbPreview';/,
  'CAD loader should reuse the same interactive point-cloud mark as mesh generation',
);

assert.match(
  source,
  /const startTime = useMemo\(\(\) => Date\.now\(\), \[\]\);/,
  'CAD loader should keep a stable generation start time while it is mounted',
);

assert.match(
  source,
  /<GlbPreview[\s\S]*startTime=\{startTime\}[\s\S]*\/>/,
  'CAD loader should render the spinnable AzureFilm letter while waiting',
);

assert.match(
  source,
  /relative flex h-full max-h-dvh w-full flex-col items-center justify-center gap-2/,
  'CAD loader should use the same full-size loading shell as mesh generation',
);

assert.doesNotMatch(
  source,
  /h-32 w-32/,
  'CAD loader should not shrink the spinnable letter to the old small icon size',
);

assert.doesNotMatch(
  source,
  /AzureFilm3DMark/,
  'CAD loader should not use the older non-interactive loading mark',
);
