import type { CreativeModel } from './types.ts';

export const TOKEN_USD_VALUE = 0.03;

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
    tokens: 10,
    description: 'Text assistant generation.',
  },
  parametric: {
    id: 'parametric',
    label: 'Parametric CAD generation',
    tokens: 35,
    description: 'Text-to-CAD generation with editable parameters.',
  },
  parametricCadPro: {
    id: 'parametric-cad-pro',
    label: 'CAD Pro generation',
    tokens: 75,
    description: 'Recommended default for accurate, practical CAD generation.',
  },
  parametricCadLite: {
    id: 'parametric-cad-lite',
    label: 'CAD Lite generation',
    tokens: 20,
    description: 'Cheaper, faster alternative for quick iterations.',
  },
  parametricCadReasoning: {
    id: 'parametric-cad-reasoning',
    label: 'CAD Reasoning generation',
    tokens: 120,
    description:
      'Alternative engine with deeper reasoning — slower and costlier per call.',
  },
  generatedInputImage: {
    id: 'generated-input-image',
    label: 'Generated input image - Image Gen 2',
    tokens: 22,
    description: 'Create a reference image from a prompt with Image Gen 2.',
  },
  generatedInputImageNanoBanana: {
    id: 'generated-input-image-nano-banana',
    label: 'Generated input image - Nano Banana 2',
    tokens: 7,
    description:
      'Create a lower-cost reference image from a prompt with Nano Banana 2.',
  },
  multiviewFrontImage: {
    id: 'multiview-front-image',
    label: 'Multiview front image',
    tokens: 22,
    description: 'Generate the first image for a four-view object set.',
  },
  multiviewNanoBananaView: {
    id: 'multiview-side-view',
    label: 'Additional multiview angle',
    tokens: 7,
    description: 'Generate one additional side or back view.',
  },
  fastMesh: {
    id: 'fast-mesh',
    label: 'Textureless mesh',
    tokens: 41,
    description: 'Fast 3D mesh generation for early shape checks.',
  },
  qualityMesh: {
    id: 'quality-mesh',
    label: 'Draft mesh',
    tokens: 34,
    description: 'Balanced 3D mesh generation for most objects.',
  },
  ultraMesh: {
    id: 'ultra-mesh',
    label: 'Max quality mesh',
    tokens: 122,
    description: 'Higher quality textured 3D mesh generation.',
  },
  multiviewMesh: {
    id: 'multiview-mesh',
    label: 'Multiview mesh',
    tokens: 28,
    description: 'Four-view 3D mesh generation.',
  },
  upscaleMesh: {
    id: 'upscale-mesh',
    label: 'Upscale mesh',
    tokens: 76,
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

export function getParametricModelTokenCost(model: string): number {
  switch (model) {
    case 'openai/gpt-5.5':
      return FEATURE_COSTS.parametricCadPro.tokens;
    case 'google/gemini-3.1-pro-preview':
      return FEATURE_COSTS.parametricCadLite.tokens;
    case 'anthropic/claude-opus-4.7':
      return FEATURE_COSTS.parametricCadReasoning.tokens;
    default:
      return FEATURE_COSTS.parametric.tokens;
  }
}

export function formatTokenCost(tokens: number): string {
  return `${tokens.toLocaleString()} token${tokens === 1 ? '' : 's'}`;
}

export function formatUsd(amount: number): string {
  return `$${amount.toFixed(amount >= 1 ? 2 : 3)}`;
}
