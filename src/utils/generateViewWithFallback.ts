import {
  getImageGenerationFallbackModel,
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
  imageGenerationModel?: ImageGenerationModel;
  // Brush-edit (inpainting) mode only. The alpha mask (OpenAI) and red-marked
  // composite (Gemini) are re-sent unchanged on every fallback attempt.
  maskImageId?: string;
  markedImageId?: string;
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
  let nextModel: ImageGenerationModel | null = model;
  let lastResult: GenerateViewInvokeResult | null = null;

  while (nextModel) {
    const provider = getImageGenerationProvider(nextModel);
    lastResult = await invoke({
      ...body,
      provider,
      imageGenerationModel: nextModel,
    });

    if (!lastResult.error) {
      return lastResult;
    }

    nextModel = getImageGenerationFallbackModel(nextModel);
  }

  return (
    lastResult ?? { data: null, error: new Error('No provider attempted') }
  );
}
