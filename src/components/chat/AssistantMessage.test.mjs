import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(
  new URL('./AssistantMessage.tsx', import.meta.url),
  'utf8',
);

assert.doesNotMatch(
  source,
  /onAddBase\?:/,
  'assistant message should not expose a post-generation add-base callback',
);

assert.doesNotMatch(
  source,
  /meshBaseSettings:/,
  'assistant message should not include add-base transform settings',
);

assert.doesNotMatch(
  source,
  /const canAddBase =[\s\S]*meshDataQuery\.data\?\.status === 'success'[\s\S]*!meshDataQuery\.data\?\.prompt\?\.meshBase/s,
  'assistant message should not compute add-base availability',
);

assert.doesNotMatch(
  source,
  /MESH_BASE_OPTIONS\.filter\([\s\S]*option\.id !== DEFAULT_MESH_BASE[\s\S]*\)/,
  'assistant message should not build add-base options',
);

assert.doesNotMatch(
  source,
  /<span>Add base<\/span>/,
  'completed mesh messages should not render an Add base action',
);

assert.doesNotMatch(
  source,
  /DEFAULT_MESH_BASE_SETTINGS/,
  'assistant message should not import add-base defaults',
);

assert.doesNotMatch(
  source,
  /Rotation[\s\S]*Scale[\s\S]*Thickness/s,
  'assistant message should not expose add-base transform controls',
);

assert.doesNotMatch(
  source,
  /<Slider[\s\S]*baseRotation[\s\S]*<Slider[\s\S]*baseScale[\s\S]*<Slider[\s\S]*baseThickness/s,
  'assistant message should not render add-base sliders',
);

assert.match(
  source,
  /CadJobArtifactDownloads/,
  'completed STEP-first CAD jobs should render export download controls',
);

assert.match(
  source,
  /downloadSTEPArtifactFile[\s\S]*downloadOBJArtifactFile/s,
  'CAD job export controls should support native STEP artifacts and OBJ conversion',
);

assert.doesNotMatch(
  source,
  /RetryModelSelector/,
  'assistant message retry controls should not render a visible model selector',
);

assert.doesNotMatch(
  source,
  /Retry with \{model\.name\}/,
  'assistant message retry controls should not expose model names in the interface',
);
