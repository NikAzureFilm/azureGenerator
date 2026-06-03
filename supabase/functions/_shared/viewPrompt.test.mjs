import assert from 'node:assert/strict';
import { buildImageGenerationPrompt, VIEW_DIRECTIVE } from './viewPrompt.ts';
import { THREE_D_OBJECT_PROMPT_ENFORCEMENT } from './imagePrompt.ts';

const views = ['front', 'left', 'back', 'right'];
const providers = ['openai', 'nano-banana'];

for (const provider of providers) {
  for (const view of views) {
    const prompt = buildImageGenerationPrompt({
      view,
      userPrompt: `${provider} test reference image`,
      hasReference: false,
      mode: 'multiview',
    });

    assert.match(
      prompt,
      /single centered 3D model, 3D object/i,
      `${provider} ${view} prompt must enforce a 3D object asset`,
    );
    assert.match(
      prompt,
      /no text, labels, UI, logos, scenery, or flat 2D illustration/i,
      `${provider} ${view} prompt must reject non-object image outputs`,
    );
    assert.ok(
      prompt.includes(VIEW_DIRECTIVE[view]),
      `${provider} ${view} prompt must include its view directive`,
    );
    assert.match(
      prompt,
      /no cast shadows, no ground shadows/i,
      `${provider} ${view} prompt must avoid shadows in generated reference images`,
    );
    assert.match(
      prompt,
      /no contact shadows/i,
      `${provider} ${view} prompt must avoid contact shadows under the object`,
    );
    assert.match(
      prompt,
      /no floor plane or ground plane/i,
      `${provider} ${view} prompt must avoid floor-plane shadows`,
    );
    assert.doesNotMatch(
      prompt,
      /soft shadow directly underneath/i,
      `${provider} ${view} prompt must not request shadows under the object`,
    );
  }
}

assert.equal(
  buildImageGenerationPrompt({
    view: 'front',
    userPrompt: 'make a poster for a coffee shop',
    hasReference: false,
    mode: 'input',
  }).startsWith(THREE_D_OBJECT_PROMPT_ENFORCEMENT),
  true,
  'input image generation must start with global 3D object enforcement',
);

assert.match(
  buildImageGenerationPrompt({
    view: 'left',
    userPrompt: '',
    hasReference: true,
    mode: 'multiview',
    referenceLabels: ['Front', 'Back'],
  }),
  /Reference images are attached in this order: Front, Back\./,
  'multiview reference labels should be preserved for left/right/back generation',
);

const inputReferencePrompt = buildImageGenerationPrompt({
  view: 'right',
  userPrompt: '',
  hasReference: true,
  mode: 'input',
});

assert.match(
  inputReferencePrompt,
  /Re-render the reference as a clean 3D-ready object input image/,
  'reference image edits should re-render as 3D object input images',
);

assert.match(
  inputReferencePrompt,
  /no cast shadows, no ground shadows/i,
  'reference image edits should avoid adding cast or ground shadows',
);

assert.match(
  inputReferencePrompt,
  /no baked-in shadow marks/i,
  'reference image edits should avoid baking shadows into the model texture',
);

assert.match(
  inputReferencePrompt,
  /no contact shadows/i,
  'reference image edits should avoid contact shadows like the dark area under the feet',
);

assert.match(
  inputReferencePrompt,
  /no ambient occlusion/i,
  'reference image edits should avoid ambient-occlusion shadows around the model',
);
