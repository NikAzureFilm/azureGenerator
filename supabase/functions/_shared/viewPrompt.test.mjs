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

assert.match(
  buildImageGenerationPrompt({
    view: 'right',
    userPrompt: '',
    hasReference: true,
    mode: 'input',
  }),
  /Re-render the reference as a clean 3D-ready object input image/,
  'reference image edits should re-render as 3D object input images',
);

// Brush-edit (inpainting) mode: changes are locked to the marked region and
// everything else must stay identical to the original render.
const editPrompt = buildImageGenerationPrompt({
  view: 'front',
  userPrompt: 'make the handle bright red',
  hasReference: true,
  mode: 'edit',
});
assert.match(
  editPrompt,
  /ONLY inside the user-marked region/,
  'edit prompt must constrain the change to the marked region',
);
assert.match(
  editPrompt,
  /make the handle bright red/,
  'edit prompt must include the user instruction',
);
assert.match(
  editPrompt,
  /remain EXACTLY identical to the original/,
  'edit prompt must require the rest of the image to stay identical',
);
assert.equal(
  buildImageGenerationPrompt({
    view: 'front',
    userPrompt: 'a red cube',
    hasReference: false,
    mode: 'input',
  }).includes('ONLY inside the user-marked region'),
  false,
  'input mode must not use the edit contract',
);
