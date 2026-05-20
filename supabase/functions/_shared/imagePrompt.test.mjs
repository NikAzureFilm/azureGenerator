import assert from 'node:assert/strict';
import {
  enforce3DObjectPrompt,
  THREE_D_OBJECT_PROMPT_ENFORCEMENT,
} from './imagePrompt.ts';

assert.match(
  THREE_D_OBJECT_PROMPT_ENFORCEMENT,
  /single centered 3D model, 3D object/i,
  'global image enforcement should require a single centered 3D model and 3D object',
);

assert.match(
  THREE_D_OBJECT_PROMPT_ENFORCEMENT,
  /single centered 3D model/i,
  'global image enforcement should explicitly require generated images to be 3D models',
);

assert.match(
  THREE_D_OBJECT_PROMPT_ENFORCEMENT,
  /not a flat 2D illustration/i,
  'global image enforcement should reject flat 2D images',
);

assert.equal(
  enforce3DObjectPrompt('Generate a Charizard.'),
  `${THREE_D_OBJECT_PROMPT_ENFORCEMENT} User request: Generate a Charizard.`,
);

assert.equal(
  enforce3DObjectPrompt(
    `${THREE_D_OBJECT_PROMPT_ENFORCEMENT} User request: Generate a Charizard.`,
  ),
  `${THREE_D_OBJECT_PROMPT_ENFORCEMENT} User request: Generate a Charizard.`,
  'prompt enforcement should be idempotent',
);

assert.equal(
  enforce3DObjectPrompt(''),
  `${THREE_D_OBJECT_PROMPT_ENFORCEMENT} User request: Generate a 3D object.`,
);
