import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const utilsSource = readFileSync(
  fileURLToPath(new URL('./utils.ts', import.meta.url)),
  'utf8',
);
const meshFunctionSource = readFileSync(
  fileURLToPath(
    new URL('../../supabase/functions/mesh/index.ts', import.meta.url),
  ),
  'utf8',
);

assert.equal(utilsSource.includes("id: 'multiview'"), false);
assert.equal(meshFunctionSource.includes("'fal-ai/pixal3d'"), true);
assert.equal(
  meshFunctionSource.includes("'fal-ai/meshy/v6-preview/image-to-3d'"),
  false,
);
assert.equal(
  meshFunctionSource.includes("'tripo3d/h3.1/multiview-to-3d'"),
  false,
);
