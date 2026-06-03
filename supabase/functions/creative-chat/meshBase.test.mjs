import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

assert.doesNotMatch(
  source,
  /content\?\.meshBase/,
  'creative chat should not read mesh base selections from initial user messages',
);

assert.doesNotMatch(
  source,
  /\.\.\(meshBase && \{ meshBase \}\)/,
  'creative chat should not forward mesh base metadata during initial generation',
);

assert.doesNotMatch(
  source,
  /direct_multiview_mesh_request[\s\S]*meshBase/s,
  'direct multiview requests should not include pre-generation base metadata',
);
