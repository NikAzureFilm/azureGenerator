export const GEMINI_35_FLASH_MODEL = 'google/gemini-3.5-flash';
export const CLAUDE_FABLE_5_MODEL = 'anthropic/claude-fable-5';
export const DEFAULT_CODE_GENERATION_MODEL = GEMINI_35_FLASH_MODEL;
export const CODE_GENERATION_FALLBACK_MODELS: string[] = [];

const PARAMETRIC_GENERATION_MODELS = new Set<string>([
  GEMINI_35_FLASH_MODEL,
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
