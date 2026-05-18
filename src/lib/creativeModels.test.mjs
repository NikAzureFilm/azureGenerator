import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const utilsSource = readFileSync(
  fileURLToPath(new URL('./utils.ts', import.meta.url)),
  'utf8',
);
const meshFunctionSource = readFileSync(
  fileURLToPath(
    new URL('../../supabase/functions/mesh/index.ts', import.meta.url),
  ),
  'utf8',
);
const pricingViewSource = readFileSync(
  fileURLToPath(new URL('../views/PricingView.tsx', import.meta.url)),
  'utf8',
);
const textAreaChatSource = readFileSync(
  fileURLToPath(new URL('../components/TextAreaChat.tsx', import.meta.url)),
  'utf8',
);
const chatSectionSource = readFileSync(
  fileURLToPath(new URL('../components/chat/ChatSection.tsx', import.meta.url)),
  'utf8',
);
const messageServiceSource = readFileSync(
  fileURLToPath(new URL('../services/messageService.ts', import.meta.url)),
  'utf8',
);

assert.equal(utilsSource.includes("id: 'ultra'"), true);
assert.equal(utilsSource.includes("id: 'quality'"), false);
assert.equal(utilsSource.includes("id: 'fast'"), false);
assert.equal(utilsSource.includes("id: 'multiview'"), false);
assert.equal(pricingViewSource.includes('FEATURE_COSTS.ultraMesh'), true);
assert.equal(pricingViewSource.includes('FEATURE_COSTS.qualityMesh'), false);
assert.equal(pricingViewSource.includes('FEATURE_COSTS.fastMesh'), false);
assert.equal(textAreaChatSource.includes("model === 'quality'"), false);
assert.equal(textAreaChatSource.includes("model === 'fast'"), false);
assert.equal(chatSectionSource.includes('normalizeCreativeModel'), true);
assert.equal(messageServiceSource.includes('normalizeCreativeModel'), true);
assert.equal(meshFunctionSource.includes("'fal-ai/pixal3d'"), true);
assert.equal(
  meshFunctionSource.includes("'fal-ai/meshy/v6-preview/image-to-3d'"),
  false,
);
assert.equal(
  meshFunctionSource.includes("'tripo3d/h3.1/multiview-to-3d'"),
  false,
);
