export const GEMINI_35_FLASH_MODEL = 'google/gemini-3.5-flash';
export const GEMINI_31_PRO_MODEL = 'google/gemini-3.1-pro-preview';
export const CLAUDE_FABLE_5_MODEL = 'anthropic/claude-fable-5';
export const GPT_55_MODEL = 'openai/gpt-5.5';
export const OPUS_48_MODEL = 'anthropic/claude-opus-4.8';
export const DEFAULT_CODE_GENERATION_MODEL = GEMINI_35_FLASH_MODEL;

export type CodeGenerationProvider = 'google' | 'openrouter';

export type CodeGenerationProviderCandidate = {
  provider: CodeGenerationProvider;
  model: string;
  usageModel: string;
};

// Canonical roster for user-selectable parametric CAD code-gen models. This is
// the SINGLE SOURCE OF TRUTH: the allow-list, per-model token cost, inspection
// rounds, output caps, and the client picker are all derived from it. Keep the
// numbers here authoritative — the admin mirrors (admin/lib/*) hardcode copies
// because the admin app can't import across the deploy boundary.
export type ParametricModelEntry = {
  id: string;
  label: string;
  description: string;
  provider: string;
  // Matches the LLM_PRICES key in shared/providerPricing.ts.
  priceKey: string;
  // Tokens charged to the user per generation (business/pricing decision).
  tokenCost: number;
  supportsVision: boolean;
  // Max agentic 7-view inspection/revise rounds (0 = inspection disabled).
  maxInspectionRounds: number;
  // Provider max output tokens for a code-gen call.
  outputTokenCap: number;
};

// Fallback output cap for models not in the roster (matches the historical
// Gemini code-gen cap).
export const DEFAULT_OUTPUT_TOKEN_CAP = 32000;

export const PARAMETRIC_MODEL_ROSTER: Record<string, ParametricModelEntry> = {
  [GEMINI_35_FLASH_MODEL]: {
    id: GEMINI_35_FLASH_MODEL,
    label: 'CAD Model',
    description: 'Fast text-to-CAD generation with editable parameters',
    provider: 'Google',
    priceKey: GEMINI_35_FLASH_MODEL,
    tokenCost: 25,
    supportsVision: true,
    maxInspectionRounds: 1,
    outputTokenCap: 32000,
  },
};

const PARAMETRIC_GENERATION_MODELS = new Set<string>(
  Object.keys(PARAMETRIC_MODEL_ROSTER),
);

function rosterEntry(model: unknown): ParametricModelEntry | undefined {
  return typeof model === 'string' ? PARAMETRIC_MODEL_ROSTER[model] : undefined;
}

export function normalizeParametricGenerationModel(model: unknown): string {
  if (typeof model === 'string' && PARAMETRIC_GENERATION_MODELS.has(model)) {
    return model;
  }

  return DEFAULT_CODE_GENERATION_MODEL;
}

// Agentic 7-view inspection rounds for a model (0 = inspection disabled). Drives
// the loop's maxRounds.
export function inspectionRoundsForModel(model: unknown): number {
  return rosterEntry(model)?.maxInspectionRounds ?? 0;
}

// Provider max-output-token cap for a model's code-gen call. Falls back to the
// default for ids not in the roster.
export function outputTokenCapForModel(model: unknown): number {
  return rosterEntry(model)?.outputTokenCap ?? DEFAULT_OUTPUT_TOKEN_CAP;
}

// Whether a model can accept image input (all current roster entries can). Used
// to decide if the same model can review its own render or needs a fallback.
export function modelSupportsVision(model: unknown): boolean {
  return rosterEntry(model)?.supportsVision ?? true;
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
