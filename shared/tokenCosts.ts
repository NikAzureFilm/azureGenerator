import type { CreativeModel } from './types.ts';

export const TOKEN_USD_VALUE = 0.01;

export type PublicFeatureCost = {
  id: string;
  label: string;
  tokens: number;
  description: string;
};

export const FEATURE_COSTS = {
  chat: {
    id: 'chat',
    label: 'Assistant message',
    tokens: 1,
    description: 'Text assistant generation.',
  },
  parametric: {
    id: 'parametric',
    label: 'Parametric CAD generation',
    tokens: 5,
    description: 'Text-to-CAD generation with editable parameters.',
  },
  parametricCadQuick: {
    id: 'parametric-cad-quick',
    label: 'CAD Quick generation',
    tokens: 3,
    description: 'Lightweight CAD generation for fast iterations.',
  },
  parametricCadPro: {
    id: 'parametric-cad-pro',
    label: 'CAD Pro generation',
    tokens: 6,
    description: 'Balanced practical CAD generation with adaptive reasoning.',
  },
  parametricCadMax: {
    id: 'parametric-cad-max',
    label: 'CAD Max generation',
    tokens: 12,
    description: 'Top-tier reasoning for complex CAD problems.',
  },
  generatedInputImage: {
    id: 'generated-input-image',
    label: 'Generated input image - Image Gen 2',
    tokens: 63,
    description: 'Create a reference image from a prompt with Image Gen 2.',
  },
  generatedInputImageNanoBanana: {
    id: 'generated-input-image-nano-banana',
    label: 'Generated input image - Nano Banana 2',
    tokens: 15,
    description:
      'Create a lower-cost reference image from a prompt with Nano Banana 2.',
  },
  multiviewFrontImage: {
    id: 'multiview-front-image',
    label: 'Multiview front image',
    tokens: 63,
    description: 'Generate the first image for a four-view object set.',
  },
  multiviewNanoBananaView: {
    id: 'multiview-side-view',
    label: 'Additional multiview angle',
    tokens: 15,
    description: 'Generate one additional side or back view.',
  },
  fastMesh: {
    id: 'fast-mesh',
    label: 'Textureless mesh',
    tokens: 26,
    description: 'Fast 3D mesh generation for early shape checks.',
  },
  qualityMesh: {
    id: 'quality-mesh',
    label: 'Draft mesh',
    tokens: 123,
    description: 'Balanced 3D mesh generation for most objects.',
  },
  ultraMesh: {
    id: 'ultra-mesh',
    label: 'Max quality mesh',
    tokens: 213,
    description: 'Higher quality textured 3D mesh generation.',
  },
  multiviewMesh: {
    id: 'multiview-mesh',
    label: 'Multiview mesh',
    tokens: 258,
    description: 'Four-view 3D mesh generation.',
  },
  upscaleMesh: {
    id: 'upscale-mesh',
    label: 'Upscale mesh',
    tokens: 213,
    description: 'Regenerate or improve an existing mesh at higher quality.',
  },
} as const satisfies Record<string, PublicFeatureCost>;

export type FeatureCostKey = keyof typeof FEATURE_COSTS;

export function getCreativeModelTokenCost(model: CreativeModel): number {
  switch (model) {
    case 'fast':
      return FEATURE_COSTS.fastMesh.tokens;
    case 'quality':
      return FEATURE_COSTS.qualityMesh.tokens;
    case 'ultra':
      return FEATURE_COSTS.ultraMesh.tokens;
    case 'multiview':
      return FEATURE_COSTS.multiviewMesh.tokens;
  }
}

export function getCreativeModelCost(model: CreativeModel): PublicFeatureCost {
  switch (model) {
    case 'fast':
      return FEATURE_COSTS.fastMesh;
    case 'quality':
      return FEATURE_COSTS.qualityMesh;
    case 'ultra':
      return FEATURE_COSTS.ultraMesh;
    case 'multiview':
      return FEATURE_COSTS.multiviewMesh;
  }
}

export function formatTokenCost(tokens: number): string {
  return `${tokens.toLocaleString()} token${tokens === 1 ? '' : 's'}`;
}

export function formatUsd(amount: number): string {
  return `$${amount.toFixed(amount >= 1 ? 2 : 3)}`;
}
