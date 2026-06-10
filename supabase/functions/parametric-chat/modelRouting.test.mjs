import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

assert.match(
  source,
  /function usesAutomaticReasoning/,
  'parametric chat should centralize automatic reasoning model gates',
);
assert.match(
  source,
  /\^claude-\[a-z\]\+-5\\b/,
  'parametric chat should enable automatic reasoning for Claude 5 model ids',
);
assert.match(
  source,
  /const reasoningEnabled = thinking \|\| usesAutomaticReasoning\(model\)/,
  'parametric chat should enable reasoning server-side even when the client omits thinking',
);
assert.match(
  source,
  /if \(reasoningEnabled\) \{\s+requestBody\.reasoning/s,
  'parametric chat agent call should use the effective reasoning flag',
);
assert.match(
  source,
  /const codeReasoningEnabled =\s+thinking \|\| usesAutomaticReasoning\(codeModel\)/s,
  'parametric chat code-generation reasoning should be based on the actual code model',
);
assert.match(
  source,
  /if \(codeReasoningEnabled\) \{\s+codeRequestBody\.reasoning/s,
  'parametric chat code-generation call should use the code-model reasoning flag',
);
assert.match(
  source,
  /const FABLE_REASONING_TOKEN_LIMIT = 1024/,
  'Claude Fable 5 should use a bounded reasoning budget that OpenRouter accepts under current key limits',
);
assert.match(
  source,
  /const FABLE_COMPLETION_TOKEN_LIMIT = 4096/,
  'Claude Fable 5 should use a bounded completion budget instead of the generic 20k/60k caps',
);
assert.match(
  source,
  /const GEMINI_CODE_GENERATION_TOKEN_LIMIT = 8000/,
  'Gemini code generation should use a bounded token budget that still emits complete OpenSCAD',
);
assert.match(
  source,
  /isGeminiCodeGenerationModel\(codeModel\)[\s\S]*effort: 'minimal'[\s\S]*exclude: true/,
  'Gemini code generation should request minimal hidden reasoning and exclude it from the response',
);
assert.match(
  source,
  /requestBody,\s+model,\s+getReasoningCompletionTokenLimit\(model, 20000\)/s,
  'parametric chat agent call should cap Fable completion tokens through the budget helper',
);
assert.match(
  source,
  /codeRequestBody,\s+codeModel,\s+getReasoningCompletionTokenLimit\(codeModel, 60000\)/s,
  'parametric chat code-generation call should cap reasoning completion tokens through the budget helper',
);
assert.match(
  source,
  /function getUserFacingOpenRouterMessage/,
  'parametric chat should convert actionable OpenRouter failures into user-facing messages',
);
assert.match(
  source,
  /OpenRouter API key has reached its monthly spend limit/,
  'OpenRouter key spend-limit failures should not render as the generic request error',
);
assert.match(
  source,
  /asUserFacingGenerationMessage\(error\) \?\?/,
  'outer failures before streaming should preserve user-facing OpenRouter diagnostics',
);
