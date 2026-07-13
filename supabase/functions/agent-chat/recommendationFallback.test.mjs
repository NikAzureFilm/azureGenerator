import assert from 'node:assert/strict';

import { buildFallbackRecommendation } from './recommendationFallback.ts';

const recommendation = buildFallbackRecommendation({
  assistantText:
    'The concept looks correct. I recommend **CAD** for precise dimensions.',
  userBriefs: [
    'Design a cable clip with a 20 mm base.',
    'Use a 6 mm cable channel.',
  ],
  hasConceptImage: true,
});

assert.equal(recommendation?.pipeline, 'cad');
assert.match(recommendation?.generationPrompt ?? '', /20 mm base/);
assert.match(recommendation?.generationPrompt ?? '', /6 mm cable channel/);
assert.match(
  recommendation?.generationPrompt ?? '',
  /exactly one contiguous, connected, watertight/i,
);

assert.equal(
  buildFallbackRecommendation({
    assistantText: 'I recommend mesh for the organic shape.',
    userBriefs: ['Design a figurine.'],
    hasConceptImage: false,
  }),
  null,
  'a recommendation should not be synthesized before a concept image exists',
);

assert.equal(
  buildFallbackRecommendation({
    assistantText: 'CAD could be an option after another revision.',
    userBriefs: ['Design a bracket.'],
    hasConceptImage: true,
  }),
  null,
  'an uncertain pipeline mention should not become a recommendation',
);

console.log('agent recommendation fallback tests passed');
