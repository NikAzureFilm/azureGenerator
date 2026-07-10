export const CAD_PREMIUM_MODEL_ID = 'openai/gpt-5.6-sol';
export const CAD_LITE_MODEL_ID = 'google/gemini-3.5-flash';

// Fallback token cost for an unrecognized CAD model id.
// Mirrors CAD_LITE_GENERATION_TOKEN_COST in shared/tokenCosts.ts — the admin app
// can't import across the deploy boundary, so it's hardcoded here.
const CAD_UNKNOWN_MODEL_TOKENS = 25;

export type CadModelDisplay = {
  id: string;
  tier: string;
  name: string;
  tokens: number | null;
};

// Hardcoded mirror of shared/parametricRouting.ts PARAMETRIC_MODEL_ROSTER
// (label/tokenCost) plus legacy IDs for old generation records. The admin app
// can't import shared/, so keep current labels and token counts in sync with the
// shared roster (that is the source of truth).
const CAD_MODEL_DISPLAYS: Record<string, CadModelDisplay> = {
  [CAD_LITE_MODEL_ID]: {
    id: CAD_LITE_MODEL_ID,
    tier: 'CAD Model',
    name: 'Gemini 3.5 Flash',
    tokens: 25,
  },
  'google/gemini-3.1-pro-preview': {
    id: 'google/gemini-3.1-pro-preview',
    tier: 'Legacy',
    name: 'Gemini 3.1 Pro',
    tokens: 25,
  },
  [CAD_PREMIUM_MODEL_ID]: {
    id: CAD_PREMIUM_MODEL_ID,
    tier: 'CAD Premium',
    name: 'GPT-5.6 Sol',
    tokens: 25,
  },
  'anthropic/claude-fable-5': {
    id: 'anthropic/claude-fable-5',
    tier: 'Legacy',
    name: 'Claude Fable 5',
    tokens: 25,
  },
  'openai/gpt-5.5': {
    id: 'openai/gpt-5.5',
    tier: 'Legacy',
    name: 'GPT-5.5',
    tokens: 25,
  },
  'anthropic/claude-opus-4.8': {
    id: 'anthropic/claude-opus-4.8',
    tier: 'Legacy',
    name: 'Claude Opus 4.8',
    tokens: 25,
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
