export const CAD_PREMIUM_MODEL_ID = 'anthropic/claude-fable-5';
export const CAD_LITE_MODEL_ID = 'google/gemini-3.5-flash';

export type CadModelDisplay = {
  id: string;
  tier: string;
  name: string;
  tokens: number | null;
};

const CAD_MODEL_DISPLAYS: Record<string, CadModelDisplay> = {
  [CAD_PREMIUM_MODEL_ID]: {
    id: CAD_PREMIUM_MODEL_ID,
    tier: 'Premium',
    name: 'Claude Fable 5',
    tokens: 50,
  },
  [CAD_LITE_MODEL_ID]: {
    id: CAD_LITE_MODEL_ID,
    tier: 'Lite',
    name: 'Gemini 3.5 Flash',
    tokens: 15,
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
  return modelId === CAD_PREMIUM_MODEL_ID ? 50 : 15;
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
