export const DEFAULT_CODE_GENERATION_MODEL = 'google/gemini-3.5-flash';
export const CODE_GENERATION_FALLBACK_MODELS = ['openai/gpt-5.5'];

export function getCodeGenerationModelCandidates(model: string): string[] {
  if (model === 'anthropic/claude-fable-5') {
    return [DEFAULT_CODE_GENERATION_MODEL, ...CODE_GENERATION_FALLBACK_MODELS];
  }
  return [...new Set([model, ...CODE_GENERATION_FALLBACK_MODELS])];
}
