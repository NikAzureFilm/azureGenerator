import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(
  new URL('./ParametricPreviewSection.tsx', import.meta.url),
  'utf8',
);

assert.match(
  source,
  /className=\{`flex h-full w-full items-center justify-center/,
  'CAD generation loading wrapper should give the full preview width to the spinnable letter',
);
