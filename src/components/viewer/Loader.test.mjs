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

assert.doesNotMatch(
  source,
  /AzureFilm3DMark/,
  'CAD loader should not use the older non-interactive loading mark',
);
