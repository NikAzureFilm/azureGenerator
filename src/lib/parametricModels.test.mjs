import assert from 'node:assert/strict';
import {
  DEFAULT_PARAMETRIC_MODEL,
  PARAMETRIC_MODELS,
  normalizeParametricChatModel,
} from './parametricModels.ts';

const liteModel = PARAMETRIC_MODELS.find(
  (model) => model.id === 'google/gemini-3.1-pro-preview',
);

assert.ok(liteModel);
assert.notEqual(liteModel.disabled, true);
assert.equal(
  normalizeParametricChatModel('google/gemini-3.1-pro-preview'),
  'google/gemini-3.1-pro-preview',
);
assert.equal(normalizeParametricChatModel(undefined), DEFAULT_PARAMETRIC_MODEL);
assert.equal(normalizeParametricChatModel('quality'), DEFAULT_PARAMETRIC_MODEL);
