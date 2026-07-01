import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  VIEW_DIRECTIVE,
  buildReferenceContext,
} from '../_shared/viewPrompt.ts';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const tokenConsumeBlock = source.match(
  /tokenLedger\.consume\(userData\.user\.email,\s*\{([\s\S]*?)\}\);/,
)?.[1];

assert.equal(
  source.includes('refImageLabels'),
  true,
  'generate-view should accept reference labels so attached multiview images are not ambiguous',
);

assert.equal(
  buildReferenceContext(['Front']).includes(
    'Reference images are attached in this order:',
  ),
  true,
  'generate-view should tell the image model which labeled view each reference image represents',
);

assert.equal(
  VIEW_DIRECTIVE.left.includes('true left-side profile'),
  true,
  'left-side directive should explicitly ask for a true left profile',
);

assert.equal(
  VIEW_DIRECTIVE.right.includes('true right-side profile'),
  true,
  'right-side directive should explicitly ask for a true right profile',
);

assert.equal(
  VIEW_DIRECTIVE.right.includes(
    'opposite side of the object from the left profile',
  ),
  true,
  'right-side directive should distinguish the right profile from the left profile',
);

assert.equal(
  source.includes("stage: 'gpt_image_2_fallback'"),
  true,
  'generate-view should log OpenAI image failures before falling back',
);

assert.equal(
  /catch \(error\) \{\s+logError\(error[\s\S]+imageBytes = await generateWithNormalOrLite\(\);/.test(
    source,
  ),
  true,
  'generate-view should fall back to Normal, then Lite, for any Premium image failure',
);

assert.ok(
  tokenConsumeBlock,
  'generate-view should charge customer tokens before generating the view image',
);

assert.match(
  tokenConsumeBlock,
  /operation:\s*'chat'/,
  'generated view images should use a valid customer token ledger operation',
);

assert.doesNotMatch(
  tokenConsumeBlock,
  /operation:\s*'image'/,
  'generated view images should not send unsupported image operations to the customer token ledger',
);

assert.match(
  tokenConsumeBlock,
  /referenceId:\s*imageId/,
  'generated view image token charges should still reference the generated image id',
);
