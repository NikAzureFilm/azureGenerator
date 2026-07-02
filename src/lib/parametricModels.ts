import { FEATURE_COSTS } from '../../shared/tokenCosts.ts';
import {
  CLAUDE_FABLE_5_MODEL,
  DEFAULT_CODE_GENERATION_MODEL,
  GEMINI_35_FLASH_MODEL,
} from '../../shared/parametricRouting.ts';
import type { ModelConfig } from '../types/misc.ts';

export const DEFAULT_PARAMETRIC_MODEL = DEFAULT_CODE_GENERATION_MODEL;

export const PARAMETRIC_MODELS: ModelConfig[] = [
  {
    id: CLAUDE_FABLE_5_MODEL,
    name: 'Premium',
    description: 'Best reasoning for complex CAD generation',
    provider: 'Anthropic',
    supportsTools: true,
    supportsThinking: true,
    supportsVision: true,
    tokenCost: FEATURE_COSTS.parametricCadReasoning.tokens,
  },
  {
    id: GEMINI_35_FLASH_MODEL,
    name: 'Lite',
    description: 'Fast CAD drafts at lower token cost',
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
