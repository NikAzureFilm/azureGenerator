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

assert.match(
  THREE_D_OBJECT_PROMPT_ENFORCEMENT,
  /convert the subject into one standalone physical 3D object asset/i,
  'global image enforcement should convert non-object image requests into standalone 3D object assets',
);

assert.match(
  THREE_D_OBJECT_PROMPT_ENFORCEMENT,
  /no cast shadows, no ground shadows/i,
  'global image enforcement should prevent baked-in or ground shadows on generated inputs',
);

assert.match(
  THREE_D_OBJECT_PROMPT_ENFORCEMENT,
  /no contact shadows/i,
  'global image enforcement should prevent contact shadows under the object',
);

assert.match(
  THREE_D_OBJECT_PROMPT_ENFORCEMENT,
  /no floor plane or ground plane/i,
  'global image enforcement should prevent product-render floor planes',
);

assert.match(
  THREE_D_OBJECT_PROMPT_ENFORCEMENT,
  /no ambient occlusion/i,
  'global image enforcement should prevent shadow-like ambient occlusion',
);

assert.doesNotMatch(
  THREE_D_OBJECT_PROMPT_ENFORCEMENT,
  /soft ground shadow/i,
  'global image enforcement should not ask image generators to add shadows',
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
