import { FEATURE_COSTS } from './tokenCosts.ts';

export type ImageGenerationModel =
  | 'gpt-image-2'
  | 'nano-banana-pro' // legacy — kept for stored records and old requests
  | 'nano-banana-2'
  | 'nano-banana-2-lite';

export type ImageGenerationProvider =
  | 'openai'
  | 'nano-banana-pro'
  | 'nano-banana'
  | 'nano-banana-lite';

export type OpenAiImageGenerationQuality = 'low' | 'medium' | 'high';

export const DEFAULT_IMAGE_GENERATION_MODEL: ImageGenerationModel =
  'nano-banana-2';

export const IMAGE_GENERATION_MODELS: Array<{
  id: ImageGenerationModel;
  name: string;
  description: string;
  provider: ImageGenerationProvider;
}> = [
  {
    id: 'gpt-image-2',
    name: 'Image Gen 2',
    description: 'Slow and usually better generations.',
    provider: 'openai',
  },
  {
    id: 'nano-banana-2',
    name: 'Nano Banana 2',
    description: 'Balanced speed and quality for most generations.',
    provider: 'nano-banana',
  },
  {
    id: 'nano-banana-2-lite',
    name: 'Nano Banana 2 Lite',
    description: 'Fastest and lowest-cost generations.',
    provider: 'nano-banana-lite',
  },
];

export function normalizeImageGenerationModel(
  model: unknown,
): ImageGenerationModel {
  if (model === 'gpt-image-2' || model === 'openai') {
    return 'gpt-image-2';
  }
  if (model === 'nano-banana-pro' || model === 'normal') {
    return 'nano-banana-pro';
  }
  if (model === 'nano-banana-2-lite' || model === 'nano-banana-lite') {
    return 'nano-banana-2-lite';
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
  if (normalized === 'nano-banana-pro') {
    return 'nano-banana-pro';
  }
  if (normalized === 'nano-banana-2') {
    return 'nano-banana';
  }
  if (normalized === 'nano-banana-2-lite') {
    return 'nano-banana-lite';
  }
  return 'openai';
}

export function getOpenAiImageGenerationQuality(
  _model: unknown,
): OpenAiImageGenerationQuality {
  return 'high';
}

export function getImageGenerationTokenCost(model: unknown): number {
  const normalized = normalizeImageGenerationModel(model);
  if (normalized === 'nano-banana-pro') {
    return FEATURE_COSTS.generatedInputImageNormal.tokens;
  }
  if (normalized === 'nano-banana-2') {
    return FEATURE_COSTS.generatedInputImageLite.tokens;
  }
  if (normalized === 'nano-banana-2-lite') {
    return FEATURE_COSTS.generatedInputImageNanoLite.tokens;
  }
  return FEATURE_COSTS.generatedInputImage.tokens;
}

export function getImageGenerationFallbackModel(
  model: unknown,
): ImageGenerationModel | null {
  const normalized = normalizeImageGenerationModel(model);
  if (normalized === 'gpt-image-2') {
    return 'nano-banana-2';
  }
  if (normalized === 'nano-banana-pro') {
    return 'nano-banana-2';
  }
  if (normalized === 'nano-banana-2') {
    return 'nano-banana-2-lite';
  }
  return null;
}
