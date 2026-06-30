export const GEMINI_31_PRO_MODEL = 'google/gemini-3.1-pro-preview';
export const DEFAULT_CODE_GENERATION_MODEL = GEMINI_31_PRO_MODEL;
export const CODE_GENERATION_FALLBACK_MODELS: string[] = [];

export function normalizeParametricGenerationModel(_model: unknown): string {
  return DEFAULT_CODE_GENERATION_MODEL;
}

export function getCodeGenerationModelCandidates(_model: string): string[] {
  return [DEFAULT_CODE_GENERATION_MODEL];
}
