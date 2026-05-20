import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

assert.equal(
  source.includes('refImageLabels'),
  true,
  'generate-view should accept reference labels so attached multiview images are not ambiguous',
);

assert.equal(
  source.includes('Reference images are attached in this order:'),
  true,
  'generate-view should tell the image model which labeled view each reference image represents',
);

assert.equal(
  source.includes('true left-side profile'),
  true,
  'left-side directive should explicitly ask for a true left profile',
);

assert.equal(
  source.includes('true right-side profile'),
  true,
  'right-side directive should explicitly ask for a true right profile',
);

assert.equal(
  source.includes('opposite side of the object from the left profile'),
  true,
  'right-side directive should distinguish the right profile from the left profile',
);
