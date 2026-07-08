export const GEMINI_35_FLASH_MODEL = 'google/gemini-3.5-flash';
export const CLAUDE_FABLE_5_MODEL = 'anthropic/claude-fable-5';
export const DEFAULT_CODE_GENERATION_MODEL = CLAUDE_FABLE_5_MODEL;

export type CodeGenerationProvider = 'google' | 'openrouter';

export type CodeGenerationProviderCandidate = {
  provider: CodeGenerationProvider;
  model: string;
  usageModel: string;
};

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

// Gemini code-gen takes the effort-based / larger-token-cap path; every other
// model (notably Fable) takes the reasoning-max_tokens path. Keyed on the
// provider prefix, NOT the default-model id (the default is now Fable, so an
// id-equality check misrouted Fable into the Gemini branch and vice-versa).
export function isGeminiCodeGenerationModel(model: string): boolean {
  return model.startsWith('google/');
}

export function getCodeGenerationProviderCandidates(
  model: unknown,
): CodeGenerationProviderCandidate[] {
  const normalized = normalizeParametricGenerationModel(model);
  if (normalized.startsWith('google/')) {
    return [
      {
        provider: 'google',
        model: normalized.slice('google/'.length),
        usageModel: normalized,
      },
      {
        provider: 'openrouter',
        model: normalized,
        usageModel: normalized,
      },
    ];
  }

  return [
    {
      provider: 'openrouter',
      model: normalized,
      usageModel: normalized,
    },
  ];
}
