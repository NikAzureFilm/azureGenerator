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

const flashModel = PARAMETRIC_MODELS.find(
  (model) => model.id === 'google/gemini-3.5-flash',
);

assert.equal(DEFAULT_PARAMETRIC_MODEL, 'google/gemini-3.5-flash');
assert.deepEqual(
  PARAMETRIC_MODELS.map((model) => model.id),
  ['google/gemini-3.5-flash'],
);
assert.ok(flashModel);
assert.equal(flashModel.name, 'Gemini 3.5 Flash');
assert.equal(flashModel.tokenCost, 50);
assert.notEqual(flashModel.disabled, true);
assert.equal(
  PARAMETRIC_MODELS.some(
    (model) => model.name === 'Premium' || model.name === 'Lite',
  ),
  false,
);
assert.equal(
  normalizeParametricChatModel('google/gemini-3.5-flash'),
  'google/gemini-3.5-flash',
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
assert.equal(parametricEditorSource.includes('normalizeParametricChatModel'), true);
