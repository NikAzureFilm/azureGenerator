export const CAD_PREMIUM_MODEL_ID = 'anthropic/claude-fable-5';
export const CAD_LITE_MODEL_ID = 'google/gemini-3.5-flash';

// Fallback token cost for an unrecognized CAD model id (the Lite tier cost).
// Mirrors CAD_LITE_GENERATION_TOKEN_COST in shared/tokenCosts.ts — the admin app
// can't import across the deploy boundary, so it's hardcoded here.
const CAD_UNKNOWN_MODEL_TOKENS = 15;

export type CadModelDisplay = {
  id: string;
  tier: string;
  name: string;
  tokens: number | null;
};

// Hardcoded mirror of shared/parametricRouting.ts PARAMETRIC_MODEL_ROSTER
// (label/tokenCost) — the admin app can't import shared/, so keep the tier
// labels and token counts in sync with the roster (that is the source of truth).
const CAD_MODEL_DISPLAYS: Record<string, CadModelDisplay> = {
  [CAD_LITE_MODEL_ID]: {
    id: CAD_LITE_MODEL_ID,
    tier: 'Lite',
    name: 'Gemini 3.5 Flash',
    tokens: 15,
  },
  'google/gemini-3.1-pro-preview': {
    id: 'google/gemini-3.1-pro-preview',
    tier: 'Gemini 3.1 Pro',
    name: 'Gemini 3.1 Pro',
    tokens: 30,
  },
  [CAD_PREMIUM_MODEL_ID]: {
    id: CAD_PREMIUM_MODEL_ID,
    tier: 'Premium',
    name: 'Claude Fable 5',
    tokens: 50,
  },
  'openai/gpt-5.5': {
    id: 'openai/gpt-5.5',
    tier: 'GPT-5.5',
    name: 'GPT-5.5',
    tokens: 60,
  },
  'anthropic/claude-opus-4.8': {
    id: 'anthropic/claude-opus-4.8',
    tier: 'Opus 4.8',
    name: 'Claude Opus 4.8',
    tokens: 90,
  },
};

type GenerationModelSource = {
  kind: string;
  prompt?: unknown;
  provider_model?: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function cadTokensForModel(model: unknown): number | null {
  const modelId = stringValue(model);
  if (!modelId) return null;
  return CAD_MODEL_DISPLAYS[modelId]?.tokens ?? CAD_UNKNOWN_MODEL_TOKENS;
}

export function cadModelDisplay(model: unknown): CadModelDisplay | null {
  const modelId = stringValue(model);
  if (!modelId) return null;
  return (
    CAD_MODEL_DISPLAYS[modelId] ?? {
      id: modelId,
      tier: 'Custom',
      name: modelId,
      tokens: cadTokensForModel(modelId),
    }
  );
}

export function cadModelDisplayText(model: unknown): string | null {
  const display = cadModelDisplay(model);
  return display ? `${display.tier} / ${display.name}` : null;
}

export function extractGenerationModelId(
  source: GenerationModelSource,
): string | null {
  if (source.kind !== 'cad' && source.kind !== 'parametric') return null;

  const prompt = isRecord(source.prompt) ? source.prompt : {};
  return (
    stringValue(prompt.model) ??
    stringValue(prompt.providerModel) ??
    stringValue(source.provider_model)
  );
}

export function generationModelDisplay(
  source: GenerationModelSource,
): CadModelDisplay | null {
  return cadModelDisplay(extractGenerationModelId(source));
}

export function generationModelDisplayText(
  source: GenerationModelSource,
): string | null {
  const display = generationModelDisplay(source);
  return display ? `${display.tier} / ${display.name}` : null;
}
