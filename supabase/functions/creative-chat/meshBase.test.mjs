import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

assert.match(
  source,
  /const meshBase = newMessage\?\.content\?\.meshBase/,
  'creative chat should read the mesh base selection from the user message',
);

assert.match(
  source,
  /\.\.\(meshBase && \{ meshBase \}\)/,
  'creative chat should forward selected mesh base metadata to the mesh endpoint',
);

assert.match(
  source,
  /direct_multiview_mesh_request[\s\S]*meshBase/s,
  'direct multiview requests should preserve selected mesh base metadata',
);
