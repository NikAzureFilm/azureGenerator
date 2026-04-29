import { FEATURE_COSTS } from './tokenCosts.ts';

export type ImageGenerationModel = 'gpt-image-2' | 'nano-banana-2';

export type ImageGenerationProvider = 'openai' | 'nano-banana';

export const DEFAULT_IMAGE_GENERATION_MODEL: ImageGenerationModel =
  'gpt-image-2';

export const IMAGE_GENERATION_MODELS: Array<{
  id: ImageGenerationModel;
  name: string;
  description: string;
  provider: ImageGenerationProvider;
}> = [
  {
    id: 'gpt-image-2',
    name: 'Premium',
    description: 'OpenAI image generation',
    provider: 'openai',
  },
  {
    id: 'nano-banana-2',
    name: 'Lite',
    description: 'Google image generation',
    provider: 'nano-banana',
  },
];

export function normalizeImageGenerationModel(
  model: unknown,
): ImageGenerationModel {
  if (model === 'gpt-image-2' || model === 'openai') {
    return 'gpt-image-2';
  }
  if (model === 'nano-banana-2' || model === 'nano-banana') {
    return 'nano-banana-2';
  }
  return DEFAULT_IMAGE_GENERATION_MODEL;
}

export function getImageGenerationProvider(
  model: unknown,
): ImageGenerationProvider {
  const normalized = normalizeImageGenerationModel(model);
  return normalized === 'nano-banana-2' ? 'nano-banana' : 'openai';
}

export function getImageGenerationTokenCost(model: unknown): number {
  return getImageGenerationProvider(model) === 'nano-banana'
    ? FEATURE_COSTS.generatedInputImageNanoBanana.tokens
    : FEATURE_COSTS.generatedInputImage.tokens;
}
