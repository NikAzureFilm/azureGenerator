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

const geminiModel = PARAMETRIC_MODELS.find(
  (model) => model.id === 'google/gemini-3.1-pro-preview',
);

assert.equal(DEFAULT_PARAMETRIC_MODEL, 'google/gemini-3.1-pro-preview');
assert.deepEqual(
  PARAMETRIC_MODELS.map((model) => model.id),
  ['google/gemini-3.1-pro-preview'],
);
assert.ok(geminiModel);
assert.equal(geminiModel.name, 'Gemini 3.1 Pro');
assert.equal(geminiModel.tokenCost, 25);
assert.notEqual(geminiModel.disabled, true);
assert.equal(
  PARAMETRIC_MODELS.some(
    (model) => model.name === 'Premium' || model.name === 'Lite',
  ),
  false,
);
assert.equal(
  normalizeParametricChatModel('google/gemini-3.1-pro-preview'),
  'google/gemini-3.1-pro-preview',
);
assert.equal(
  normalizeParametricChatModel('google/gemini-3.5-flash'),
  DEFAULT_PARAMETRIC_MODEL,
);
assert.equal(
  normalizeParametricChatModel('anthropic/claude-fable-5'),
  DEFAULT_PARAMETRIC_MODEL,
);
assert.equal(
  normalizeParametricChatModel('google/gemini-3.1-pro-preview'),
  DEFAULT_PARAMETRIC_MODEL,
);
assert.equal(
  normalizeParametricChatModel('openai/gpt-5.5'),
  DEFAULT_PARAMETRIC_MODEL,
);
assert.equal(normalizeParametricChatModel(undefined), DEFAULT_PARAMETRIC_MODEL);
assert.equal(normalizeParametricChatModel('quality'), DEFAULT_PARAMETRIC_MODEL);
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
