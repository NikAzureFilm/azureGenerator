import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(
  new URL('./ImageGenerateDialog.tsx', import.meta.url),
  'utf8',
);

assert.match(
  source,
  /3D Object Agent/,
  'image generation dialog should surface the 3D object agent constraint',
);

assert.match(
  source,
  /<Collapsible open=\{isBriefOpen\}/,
  'raw image generation prompt should be hidden behind an advanced disclosure',
);

assert.match(
  source,
  /Every generated image is constrained to one centered,\s+fully-rendered 3D object asset/s,
  'dialog copy should make the always-3D-object behavior clear',
);

assert.doesNotMatch(
  source,
  /<Textarea[\s\S]*?<\/Textarea>[\s\S]*?<Collapsible/,
  'prompt textarea should not be the primary visible image generation control',
);
