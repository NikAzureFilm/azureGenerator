import { FEATURE_COSTS } from '../../shared/tokenCosts.ts';
import { DEFAULT_CODE_GENERATION_MODEL } from '../../shared/parametricRouting.ts';
import type { ModelConfig } from '../types/misc.ts';

export const DEFAULT_PARAMETRIC_MODEL = DEFAULT_CODE_GENERATION_MODEL;

export const PARAMETRIC_MODELS: ModelConfig[] = [
  {
    id: DEFAULT_CODE_GENERATION_MODEL,
    name: 'Gemini 3.1 Pro',
    description: 'CADAM-style CAD generation with Google Gemini 3.1 Pro',
    provider: 'Google',
    supportsTools: true,
    supportsThinking: true,
    supportsVision: true,
    tokenCost: FEATURE_COSTS.parametric.tokens,
  },
];

export function normalizeParametricChatModel(
  model: string | undefined,
): string {
  if (
    !model ||
    model === 'fast' ||
    model === 'quality' ||
    model === 'ultra' ||
    !PARAMETRIC_MODELS.some((candidate) => candidate.id === model)
  ) {
    return DEFAULT_PARAMETRIC_MODEL;
  }

  return model;
}
