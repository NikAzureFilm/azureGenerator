import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  AGENT_CONCEPT_IMAGE_PROMPT_ENFORCEMENT,
  buildAgentConceptImagePrompt,
  THREE_D_OBJECT_PROMPT_ENFORCEMENT,
} from '../_shared/imagePrompt.ts';
import { buildImageGenerationPrompt } from '../_shared/viewPrompt.ts';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

assert.match(
  source,
  /import \{ buildAgentConceptImagePrompt \} from '\.\.\/_shared\/imagePrompt\.ts';/,
  'agent-chat should import the server-side concept render prompt builder',
);

assert.match(
  source,
  /prompt:\s*applyFlatBottomImageDirective\(\s*buildAgentConceptImagePrompt\(toolInput\.prompt\),\s*flatBottom,\s*\)/,
  'every agent concept image should receive the 3D/CAD render art direction at the generation boundary, plus the flat-bottom directive when the option is on',
);

assert.match(
  source,
  /practical CAD parts, show a slightly elevated three-quarter view on white with a neutral graphite solid material/i,
  'the design agent should explicitly describe the practical CAD render style',
);

const deliveredPrompt = buildImageGenerationPrompt({
  view: 'front',
  userPrompt: buildAgentConceptImagePrompt(
    'A 20 mm square desk cable clip with a 6 mm channel.',
  ),
  hasReference: false,
  mode: 'input',
});

assert.ok(
  deliveredPrompt.startsWith(THREE_D_OBJECT_PROMPT_ENFORCEMENT),
  'the final agent image request should retain global 3D-object enforcement',
);
assert.ok(
  deliveredPrompt.includes(AGENT_CONCEPT_IMAGE_PROMPT_ENFORCEMENT),
  'the final agent image request should include the CAD render art direction',
);
assert.equal(
  deliveredPrompt.split(THREE_D_OBJECT_PROMPT_ENFORCEMENT).length - 1,
  1,
  'the final agent image request should not duplicate the global enforcement block',
);
