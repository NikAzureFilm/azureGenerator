import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(
  new URL('./TextAreaChat.tsx', import.meta.url),
  'utf8',
);
const chatSectionSource = readFileSync(
  new URL('./chat/ChatSection.tsx', import.meta.url),
  'utf8',
);
const promptViewSource = readFileSync(
  new URL('../views/PromptView.tsx', import.meta.url),
  'utf8',
);

assert.doesNotMatch(
  source,
  new RegExp(
    [
      `VITE_${'TEXT_TO_'}${'CAD_ENABLED'}`,
      `text-to-${'cad'}`,
      'CadBackendSelector',
    ].join('|'),
  ),
  'composer should not expose the removed backend selector',
);

assert.doesNotMatch(
  source,
  /onSubmit\(content\);\s*setInput\(''\);\s*setMultiviewSlots\(\{\}\);/s,
  'submitting multiview generation should keep the four image holders populated while generation is in progress',
);

assert.doesNotMatch(
  source,
  /from '@shared\/meshBase'/,
  'composer should not expose mesh base selection before a mesh is generated',
);

assert.doesNotMatch(
  source,
  /MeshBaseButton|meshBase !== DEFAULT_MESH_BASE|setMeshBase/,
  'base selection should not be part of the initial mesh generation payload',
);

assert.match(
  chatSectionSource,
  /latestMultiviewImages[\s\S]*message\.role === 'user'[\s\S]*message\.content\.multiviewImages/s,
  'chat section should find the latest user multiview image set from the active branch',
);

assert.match(
  chatSectionSource,
  /<TextAreaChat[\s\S]*seedMultiviewImages=\{latestMultiviewImages\}/s,
  'chat section should pass the latest multiview images into the composer',
);

assert.match(
  source,
  /ensureConversation\?:\s*\(\)\s*=>\s*Promise<void>/,
  'composer should accept a hook for persisting draft conversations before input image generation',
);

assert.match(
  source,
  /await ensureConversation\?\.\(\);[\s\S]*supabase\.functions\.invoke\('generate-view'/,
  'input image generation should persist the draft conversation before calling generate-view',
);

assert.match(
  promptViewSource,
  /ensureConversation=\{ensureConversation\}/,
  'prompt view should provide the draft conversation persistence hook to the composer',
);

assert.match(
  promptViewSource,
  /\.from\('conversations'\)[\s\S]*\.upsert\(/,
  'prompt view should tolerate a pre-created conversation when sending the first message',
);
