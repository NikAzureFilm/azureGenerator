import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(
  new URL('./TextAreaChat.tsx', import.meta.url),
  'utf8',
);

assert.match(
  source,
  /description:\s*'Best for simple CAD parts you want to edit and preview quickly'/,
  'SCAD backend description should explain when a user should choose it',
);

assert.match(
  source,
  /description:\s*'Best for more complex solid CAD designs and export workflows'/,
  'STEP backend description should explain when a user should choose it',
);

assert.doesNotMatch(
  source,
  /description:\s*'[^']*(?:OpenSCAD|build123d|STEP-first)[^']*'/,
  'CAD backend descriptions should avoid implementation details in user-facing copy',
);

assert.doesNotMatch(
  source,
  /onSubmit\(content\);\s*setInput\(''\);\s*setMultiviewSlots\(\{\}\);/s,
  'submitting multiview generation should keep the four image holders populated while generation is in progress',
);
