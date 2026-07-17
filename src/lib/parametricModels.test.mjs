import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_PARAMETRIC_MODEL,
  PARAMETRIC_MODELS,
  normalizeParametricChatModel,
} from './parametricModels.ts';

const promptViewSource = readFileSync(
  fileURLToPath(new URL('../views/PromptView.tsx', import.meta.url)),
  'utf8',
);
const chatSectionSource = readFileSync(
  fileURLToPath(new URL('../components/chat/ChatSection.tsx', import.meta.url)),
  'utf8',
);
const parametricEditorSource = readFileSync(
  fileURLToPath(new URL('../views/ParametricEditorView.tsx', import.meta.url)),
  'utf8',
);
const utilsSource = readFileSync(
  fileURLToPath(new URL('./utils.ts', import.meta.url)),
  'utf8',
);
const modelSelectorSource = readFileSync(
  fileURLToPath(new URL('../components/ModelSelector.tsx', import.meta.url)),
  'utf8',
);

const cadPremium = PARAMETRIC_MODELS.find(
  (model) => model.id === 'openai/gpt-5.6-sol',
);
const kimiK3 = PARAMETRIC_MODELS.find(
  (model) => model.id === 'moonshotai/kimi-k3',
);

assert.equal(DEFAULT_PARAMETRIC_MODEL, 'openai/gpt-5.6-sol');
assert.deepEqual(
  PARAMETRIC_MODELS.map((model) => model.id),
  ['openai/gpt-5.6-sol', 'moonshotai/kimi-k3'],
);
assert.ok(cadPremium);
assert.equal(cadPremium.name, 'CAD Premium');
assert.equal(cadPremium.provider, 'OpenAI');
assert.equal(cadPremium.tokenCost, 25);
assert.equal(cadPremium.supportsVision, true);
assert.notEqual(cadPremium.disabled, true);
assert.ok(kimiK3);
assert.equal(kimiK3.name, 'Kimi K3');
assert.equal(kimiK3.provider, 'Moonshot AI');
assert.equal(kimiK3.tokenCost, 25);
assert.equal(kimiK3.supportsVision, true);
assert.notEqual(kimiK3.disabled, true);
// Every roster model is a valid picker choice (normalizes to itself).
for (const model of PARAMETRIC_MODELS) {
  assert.equal(normalizeParametricChatModel(model.id), model.id);
}
assert.equal(normalizeParametricChatModel(undefined), DEFAULT_PARAMETRIC_MODEL);
assert.equal(normalizeParametricChatModel('quality'), DEFAULT_PARAMETRIC_MODEL);
// Stale clients still sending the retired Gemini id get the default model.
assert.equal(
  normalizeParametricChatModel('google/gemini-3.5-flash'),
  DEFAULT_PARAMETRIC_MODEL,
);
for (const source of [
  promptViewSource,
  chatSectionSource,
  parametricEditorSource,
  utilsSource,
]) {
  assert.equal(source.includes("?? 'openai/gpt-5.5'"), false);
  assert.equal(source.includes("return 'openai/gpt-5.5'"), false);
}
assert.equal(chatSectionSource.includes('normalizeParametricChatModel'), true);
assert.equal(
  parametricEditorSource.includes('normalizeParametricChatModel'),
  true,
);
assert.equal(modelSelectorSource.includes('aria-label="Model cost"'), true);
assert.equal(
  modelSelectorSource.includes(
    '<span className="font-normal">{model?.name}</span>',
  ),
  false,
);
assert.equal(modelSelectorSource.includes('{model.name}'), true);
