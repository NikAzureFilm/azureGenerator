export const GEMINI_31_PRO_MODEL = 'google/gemini-3.1-pro-preview';
export const CLAUDE_FABLE_5_MODEL = 'anthropic/claude-fable-5';
export const DEFAULT_CODE_GENERATION_MODEL = GEMINI_31_PRO_MODEL;
export const CODE_GENERATION_FALLBACK_MODELS: string[] = [];

const PARAMETRIC_GENERATION_MODELS = new Set<string>([
  GEMINI_31_PRO_MODEL,
  CLAUDE_FABLE_5_MODEL,
]);

export function normalizeParametricGenerationModel(model: unknown): string {
  if (typeof model === 'string' && PARAMETRIC_GENERATION_MODELS.has(model)) {
    return model;
  }

  return DEFAULT_CODE_GENERATION_MODEL;
}

export function getCodeGenerationModelCandidates(model: string): string[] {
  return [normalizeParametricGenerationModel(model)];
}
