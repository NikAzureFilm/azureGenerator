import {
  getImageGenerationProvider,
  type ImageGenerationModel,
  type ImageGenerationProvider,
} from '../../shared/imageGeneration.ts';

export type GenerateViewBody = {
  conversationId: string;
  view: string;
  prompt: string;
  mode: string;
  refImageId?: string;
  refImageIds?: string[];
  refImageLabels?: string[];
  provider?: ImageGenerationProvider;
};

export type GenerateViewData = {
  id: string;
  url: string;
};

export type GenerateViewInvokeResult = {
  data: GenerateViewData | null;
  error?: unknown;
};

export async function invokeGenerateViewWithFallback(
  invoke: (body: GenerateViewBody) => Promise<GenerateViewInvokeResult>,
  body: Omit<GenerateViewBody, 'provider'>,
  model: ImageGenerationModel,
): Promise<GenerateViewInvokeResult> {
  const provider = getImageGenerationProvider(model);
  const firstResult = await invoke({ ...body, provider });

  if (!firstResult.error || provider !== 'openai') {
    return firstResult;
  }

  return await invoke({ ...body, provider: 'nano-banana' });
}
