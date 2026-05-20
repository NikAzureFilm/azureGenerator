import { FEATURE_COSTS } from '../../shared/tokenCosts.ts';
import type { ModelConfig } from '../types/misc.ts';

export const DEFAULT_PARAMETRIC_MODEL = 'google/gemini-3.5-flash';

export const PARAMETRIC_MODELS: ModelConfig[] = [
  {
    id: 'google/gemini-3.5-flash',
    name: 'Gemini 3.5 Flash',
    description: 'Fast, lower-cost CAD generation with Gemini 3.5 Flash',
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
