import assert from 'node:assert/strict';
import {
  AGENT_CONCEPT_IMAGE_PROMPT_ENFORCEMENT,
  buildAgentConceptImagePrompt,
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
  /one contiguous physical piece[\s\S]*no floating, hovering, or detached parts[\s\S]*single connected object/i,
  'global image enforcement should require a single connected, contiguous printable piece',
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

assert.match(
  AGENT_CONCEPT_IMAGE_PROMPT_ENFORCEMENT,
  /slightly elevated three-quarter isometric camera/i,
  'agent concepts should use a three-quarter 3D-object presentation',
);

assert.match(
  AGENT_CONCEPT_IMAGE_PROMPT_ENFORCEMENT,
  /practical, functional, dimensioned, mechanical, or CAD-style parts[\s\S]*neutral matte graphite or dark-gray solid CAD material/i,
  'practical CAD concepts should look like polished solid-model renders',
);

assert.match(
  AGENT_CONCEPT_IMAGE_PROMPT_ENFORCEMENT,
  /never as a photograph of an object in a real environment/i,
  'agent concepts should not become lifestyle photographs',
);

assert.match(
  AGENT_CONCEPT_IMAGE_PROMPT_ENFORCEMENT,
  /faithful, vibrant, true-to-character colors and materials[\s\S]*never use gray, graphite, or monochrome CAD material/i,
  'character/organic/decorative concepts should keep true-to-character colors, never gray CAD material',
);

const agentConceptPrompt = buildAgentConceptImagePrompt(
  'A 20 mm square desk cable clip with a 6 mm channel.',
);
assert.ok(
  agentConceptPrompt.startsWith(AGENT_CONCEPT_IMAGE_PROMPT_ENFORCEMENT),
  'agent concepts should put the agent render art direction first',
);
assert.ok(
  agentConceptPrompt.includes(AGENT_CONCEPT_IMAGE_PROMPT_ENFORCEMENT),
  'agent concepts should include the agent-specific render art direction',
);
assert.match(agentConceptPrompt, /20 mm square desk cable clip/);
assert.equal(
  buildAgentConceptImagePrompt(agentConceptPrompt),
  agentConceptPrompt,
  'agent concept prompt enforcement should be idempotent',
);
