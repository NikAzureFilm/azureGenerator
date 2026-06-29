import type { CadBackend, CreativeModel } from './types.ts';

export const TOKEN_INTERNAL_USD_COST = 0.01;
export const TOKEN_USD_VALUE = 0.03;
const TEXT_TO_CAD_WORKER_TOKENS = 140;

export function tokensForProviderCost(providerCostUsd: number): number {
  return Math.max(
    0,
    Math.ceil(providerCostUsd / TOKEN_INTERNAL_USD_COST - 1e-9),
  );
}

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
  promptGeneration: {
    id: 'prompt-generation',
    label: 'Prompt helper',
    tokens: 10,
    description: 'Generate or enhance a modeling prompt.',
  },
  parametric: {
    id: 'parametric',
    label: 'Parametric CAD generation',
    tokens: 50,
    description: 'Text-to-CAD generation with editable parameters.',
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
    label: 'Generated input image - Premium',
    tokens: 22,
    description: 'Create a reference image from a prompt with Premium.',
  },
  generatedInputImageLite: {
    id: 'generated-input-image-lite',
    label: 'Generated input image - Lite',
    tokens: 7,
    description: 'Create a lower-cost reference image from a prompt with Lite.',
  },
  multiviewFrontImage: {
    id: 'multiview-front-image',
    label: 'Multiview front image',
    tokens: 22,
    description: 'Generate the first image for a four-view object set.',
  },
  multiviewLiteView: {
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
    tokens: 110,
    description: 'Highest quality textured 3D mesh generation.',
  },
  multiviewMesh: {
    id: 'multiview-mesh',
    label: 'Multiview mesh',
    tokens: 61,
    description: 'Hunyuan Pro four-view 3D mesh generation.',
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
    case 'anthropic/claude-fable-5':
    case 'anthropic/claude-opus-4.7':
      return FEATURE_COSTS.parametricCadReasoning.tokens;
    default:
      return FEATURE_COSTS.parametric.tokens;
  }
}

export function getCadBackendTokenCost(
  backend: CadBackend,
  model: string,
): number {
  const baseCost =
    FEATURE_COSTS.chat.tokens + getParametricModelTokenCost(model);
  switch (backend) {
    case 'openscad':
      return baseCost;
    case 'text-to-cad':
      return baseCost + TEXT_TO_CAD_WORKER_TOKENS;
  }
}

export function formatTokenCost(tokens: number): string {
  return `${tokens.toLocaleString()} token${tokens === 1 ? '' : 's'}`;
}

export function formatUsd(amount: number): string {
  return `$${amount.toFixed(amount >= 1 ? 2 : 3)}`;
}
