import {
  DEFAULT_CODE_GENERATION_MODEL,
  PARAMETRIC_MODEL_ROSTER,
} from '../../shared/parametricRouting.ts';
import type { ModelConfig } from '../types/misc.ts';

export const DEFAULT_PARAMETRIC_MODEL = DEFAULT_CODE_GENERATION_MODEL;

// Derived from the canonical shared roster so the picker, the server allow-list,
// and per-model token costs never drift.
export const PARAMETRIC_MODELS: ModelConfig[] = Object.values(
  PARAMETRIC_MODEL_ROSTER,
).map((entry) => ({
  id: entry.id,
  name: entry.label,
  description: entry.description,
  provider: entry.provider,
  supportsTools: true,
  supportsThinking: true,
  supportsVision: entry.supportsVision,
  tokenCost: entry.tokenCost,
}));

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
