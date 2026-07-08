import {
  cadTokensForModel,
  extractGenerationModelId,
} from './generationModels.ts';

const PREMIUM_IMAGE_TOKENS = 22;
const NORMAL_IMAGE_TOKENS = 14;
const LITE_IMAGE_TOKENS = 7;
const NANO_LITE_IMAGE_TOKENS = 4;

type MetadataLike = Record<string, unknown> | null | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function generatedViewSource(prompt: unknown, metadata: MetadataLike): boolean {
  const promptRecord = isRecord(prompt) ? prompt : {};
  const metadataRecord = isRecord(metadata) ? metadata : {};
  return (
    promptRecord.generated === true ||
    promptRecord.source === 'generate-view' ||
    metadataRecord.source === 'generate-view'
  );
}

function imageTokensForModel(model: unknown): number | null {
  switch (stringValue(model)) {
    case 'gpt-image-2':
    case 'openai':
      return PREMIUM_IMAGE_TOKENS;
    case 'nano-banana-pro':
    case 'normal':
      return NORMAL_IMAGE_TOKENS;
    case 'nano-banana-2-lite':
    case 'nano-banana-lite':
      return NANO_LITE_IMAGE_TOKENS;
    case 'nano-banana-2':
    case 'nano-banana':
      return LITE_IMAGE_TOKENS;
    default:
      return null;
  }
}

function inferredGeneratedViewImageTokens(row: {
  prompt?: unknown;
  provider_model?: string | null;
  asset_metadata?: MetadataLike;
}): number | null {
  if (!generatedViewSource(row.prompt, row.asset_metadata)) return null;

  const promptRecord = isRecord(row.prompt) ? row.prompt : {};
  const metadataRecord = isRecord(row.asset_metadata) ? row.asset_metadata : {};

  return (
    imageTokensForModel(promptRecord.imageGenerationModel) ??
    imageTokensForModel(metadataRecord.imageGenerationModel) ??
    imageTokensForModel(row.provider_model) ??
    null
  );
}

export function displayGenerationTokens(row: {
  kind: string;
  tokens_used: number | null;
  prompt?: unknown;
  provider_model?: string | null;
  asset_metadata?: MetadataLike;
}): number | null {
  if (row.kind === 'cad' || row.kind === 'parametric') {
    return (
      row.tokens_used ??
      cadTokensForModel(extractGenerationModelId(row) ?? row.provider_model)
    );
  }

  if (row.kind === 'image') {
    return row.tokens_used ?? inferredGeneratedViewImageTokens(row);
  }

  return row.tokens_used;
}
