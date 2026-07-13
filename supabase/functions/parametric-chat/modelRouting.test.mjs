import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  isGeminiCodeGenerationModel,
  outputTokenCapForModel,
} from '../../../shared/parametricRouting.ts';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

// Routes on the provider prefix, NOT the default-model id (the default is Fable
// now, so an id-equality check misrouted Fable into the Gemini branch).
assert.equal(isGeminiCodeGenerationModel('google/gemini-3.5-flash'), true);
assert.equal(isGeminiCodeGenerationModel('anthropic/claude-fable-5'), false);
assert.equal(isGeminiCodeGenerationModel('openai/gpt-5.5'), false);
assert.equal(isGeminiCodeGenerationModel('openai/gpt-5.6-sol'), false);

assert.match(
  source,
  /function usesAutomaticReasoning/,
  'parametric chat should centralize automatic reasoning model gates',
);
assert.match(
  source,
  /\^claude-\[a-z\]\+-5\\b/,
  'parametric chat should enable automatic reasoning for configured reasoning ids',
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
  /const FABLE_REASONING_TOKEN_LIMIT = 8000/,
  'Claude Fable 5 should use a bounded reasoning budget that OpenRouter accepts under current key limits',
);
assert.match(
  source,
  /const FABLE_COMPLETION_TOKEN_LIMIT = 24000/,
  'Claude Fable 5 should use a bounded completion budget instead of the generic 20k/60k caps',
);
// Code-gen output caps now come from the shared roster (outputTokenCapForModel),
// not an index.ts constant. Removed models fall back to the default cap.
assert.equal(outputTokenCapForModel('google/gemini-3.5-flash'), 32000);
assert.equal(outputTokenCapForModel('google/gemini-3.1-pro-preview'), 32000);
assert.equal(outputTokenCapForModel('openai/gpt-5.5'), 32000);
assert.equal(outputTokenCapForModel('openai/gpt-5.6-sol'), 32000);
assert.equal(outputTokenCapForModel('anthropic/claude-opus-4.8'), 32000);
assert.equal(outputTokenCapForModel('anthropic/claude-fable-5'), 32000);
assert.match(
  source,
  /const codeOutputCap = outputTokenCapForModel\(codeModel\)/,
  'code generation should derive its output cap from the shared per-model roster',
);
assert.match(
  source,
  /isGeminiCodeGenerationModel\(codeModel\)[\s\S]*effort: 'medium'[\s\S]*exclude: true/,
  'Gemini code generation should request medium hidden reasoning and exclude it from the response',
);
assert.match(
  source,
  /function usesHighEffortReasoning/,
  'parametric chat should centralize the always-high-reasoning model gate',
);
assert.match(
  source,
  /\} else if \(usesHighEffortReasoning\(codeModel\)\) \{[\s\S]{0,300}?effort: 'high',\s+exclude: true/,
  'GPT-5.6 Sol round-0 code generation should always run at high hidden reasoning',
);
assert.match(
  source,
  /reasoningEffort === 'high' \|\|\s+usesHighEffortReasoning\(codeModel\)/,
  'GPT-5.6 Sol continuation code generation should always run at high hidden reasoning',
);
assert.match(
  source,
  /const model = normalizeParametricGenerationModel\(requestedModel\)/,
  'parametric chat should normalize stale client model ids to the configured CAD model',
);
assert.match(
  source,
  /model: DEFAULT_CODE_GENERATION_MODEL/,
  'parametric title generation should use the configured CAD model',
);
assert.match(
  source,
  /reasoning: \{ effort: 'minimal', exclude: true \},\s+max_tokens: 1000/,
  'title generation must leave headroom for hidden reasoning tokens (a 30-token cap returns an empty title on a reasoning model)',
);
assert.match(
  source,
  /requestBody,\s+model,\s+getReasoningCompletionTokenLimit\(model, 20000\)/s,
  'parametric chat agent call should cap Fable completion tokens through the budget helper',
);
assert.match(
  source,
  /codeRequestBody,\s+codeModel,\s+getReasoningCompletionTokenLimit\(codeModel, codeOutputCap\)/s,
  'parametric chat code-generation call should cap reasoning completion tokens through the per-model roster cap',
);
assert.match(
  source,
  /new GoogleGenAI\(\{\s*apiKey: GOOGLE_API_KEY/s,
  'parametric chat should configure the direct Google provider for Gemini code generation',
);
assert.match(
  source,
  /for \(const providerCandidate of getCodeGenerationProviderCandidates\(\s*model,\s*\)\)/s,
  'parametric chat code generation should try provider candidates, not alternate model ids',
);
assert.match(
  source,
  /providerCandidate\.provider === 'google'[\s\S]*googleGenAI\.models\.generateContent/,
  'parametric chat should call the direct Gemini API before falling back to OpenRouter',
);
assert.match(
  source,
  /provider: 'google'[\s\S]*model: providerCandidate\.usageModel/,
  'direct Gemini code generation usage should be logged as the Google provider',
);
assert.doesNotMatch(
  source,
  /getCodeGenerationModelCandidates\(model\)/,
  'parametric chat should not use model fallback routing for code generation',
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
