import { FEATURE_COSTS } from '../../shared/tokenCosts.ts';
import type { ModelConfig } from '../types/misc.ts';

export const DEFAULT_PARAMETRIC_MODEL = 'openai/gpt-5.5';

export const PARAMETRIC_MODELS: ModelConfig[] = [
  {
    id: DEFAULT_PARAMETRIC_MODEL,
    name: 'Premium',
    description: 'Most powerful OpenAI model with adaptive reasoning',
    provider: 'OpenAI',
    supportsTools: true,
    supportsThinking: true,
    supportsVision: true,
    tokenCost: FEATURE_COSTS.parametricCadPro.tokens,
  },
  {
    id: 'google/gemini-3.1-pro-preview',
    name: 'Lite',
    description: 'Fast, lower-cost CAD generation with Gemini 3.1 Pro',
    provider: 'Google',
    supportsTools: true,
    supportsThinking: true,
    supportsVision: true,
    tokenCost: FEATURE_COSTS.parametricCadLite.tokens,
  },
];

export function normalizeParametricChatModel(
  model: string | undefined,
): string {
  if (!model || model === 'fast' || model === 'quality' || model === 'ultra') {
    return DEFAULT_PARAMETRIC_MODEL;
  }

  return model;
}
