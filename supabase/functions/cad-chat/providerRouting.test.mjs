import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

assert.match(
  source,
  /import \{ GoogleGenAI \} from 'npm:@google\/genai'/,
  'cad-chat should import the direct Google provider client',
);
assert.match(
  source,
  /new GoogleGenAI\(\{\s*apiKey: GOOGLE_API_KEY/s,
  'cad-chat should configure the direct Google provider for Gemini CAD source generation',
);
assert.match(
  source,
  /const candidates = getCodeGenerationProviderCandidates\(model\)/,
  'cad-chat should build provider candidates, not alternate model ids',
);
assert.match(
  source,
  /for \(const candidate of candidates\)/,
  'cad-chat should iterate through configured provider candidates',
);
assert.match(
  source,
  /candidate\.provider === 'google'[\s\S]*googleGenAI\.models\.generateContent/,
  'cad-chat should call the direct Gemini API before falling back to OpenRouter',
);
assert.match(
  source,
  /provider: 'google'[\s\S]*model: candidate\.usageModel/,
  'direct Gemini CAD source usage should be logged as the Google provider',
);
assert.doesNotMatch(
  source,
  /if \(!OPENROUTER_API_KEY\) \{\s*throw new Error\('OPENROUTER_API_KEY is not configured\.'\);/s,
  'cad-chat should not fail before trying a configured direct Google provider',
);

console.log('cad-chat provider routing tests passed');
