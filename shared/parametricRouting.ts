export const CODE_GENERATION_FALLBACK_MODELS = ['anthropic/claude-haiku-4.5'];

export function getCodeGenerationModelCandidates(model: string): string[] {
  return [...new Set([model, ...CODE_GENERATION_FALLBACK_MODELS])];
}
