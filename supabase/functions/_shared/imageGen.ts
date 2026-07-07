import { Buffer } from 'node:buffer';
import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.9';
import { GoogleGenAI, Modality } from 'npm:@google/genai';
import { fal } from 'npm:@fal-ai/client';
import OpenAI from 'npm:openai@^6.34.0';
import { reformatSignedUrl } from './messageUtils.ts';
import { detectImageMediaType } from './imageMime.ts';
import { enforce3DObjectPrompt } from './imagePrompt.ts';
import {
  logFalUsage,
  logGeminiImage,
  logOpenAiImage,
} from './providerUsage.ts';

const DEBUG_LOGS =
  Deno.env.get('ENVIRONMENT') === 'local' ||
  Deno.env.get('DEBUG_LOGS') === 'true';
const debugLog = (...args: unknown[]) => {
  if (DEBUG_LOGS) console.log(...args);
};

const GEMINI_FLASH_IMAGE_MODEL = 'gemini-3.1-flash-image-preview';
// Nano Banana 2 Lite — Google's lowest-cost image model.
export const GEMINI_FLASH_LITE_IMAGE_MODEL = 'gemini-3.1-flash-lite-image';
const OPENAI_IMAGE_ORCHESTRATOR_MODEL = 'gpt-5.5';
const OPENAI_IMAGE_MODEL = 'gpt-image-2';

// Shared 3D model generation instructions for consistency across all image generation services
export const INSTRUCTIONS_3D =
  'You are generating a fully textured and rendered 3D model. Output one centered 3D object or 3D character asset, no text unless the user explicitly asks for lettering. Plain white background (or an empty background which provides optimal contrast with the textures of the 3D model), neutral lighting, and a soft shadow directly under the 3D model. Keep the entire object fully in-frame with 5-10% padding; no cropping. Make sure the description strongly impacts the form and shape of the 3D Model not just the surface texture. Make the asset 3D-printable by default: watertight, manifold, closed surface geometry with a clear stable contact area on the print bed, practical minimum wall thickness of 1.2 mm or thicker for FDM, and no paper-thin fins, floating fragments, internal loose shells, or unsupported needle-like details. For printable multicolor badges, emblems, signs, ornaments, logos, and 2.5D reliefs, create real material regions as separate raised or recessed geometry, separate meshes, or named materials instead of relying on one baked texture. Use clear material or mesh names such as light_silver_raised_border, light_silver_raised_text, green_enamel_field, black_ball_panels, and yellow_accent_stripe so downstream 3MF export can map the regions to light silver, black, green, and yellow.';

// Trim to survive copy-pasted env vars with trailing newlines
// (newline in Authorization header makes fetch throw and breaks all FAL calls).
fal.config({
  credentials: Deno.env.get('FAL_KEY')?.trim() ?? '',
});

export type GptImageQuality = 'low' | 'medium' | 'high';

// Context for recording the actual provider $ cost of a generated image. When
// passed to a generator, the generator that actually succeeds logs its own
// cost to provider_usage (correct under the fallback chains).
export type ImageUsageCtx = {
  functionName: string;
  operation: string;
  userId?: string | null;
  conversationId?: string | null;
  referenceId?: string | null;
};

export type GptImage2Result = {
  imageBytes: Buffer;
  imageCallId: string | null;
  // MIME of the returned bytes — gpt-image-2 returns jpeg per our tool
  // config. Callers must use this when persisting to storage so the
  // Content-Type header matches the actual bytes.
  contentType: 'image/jpeg';
};

/**
 * Generates an image with gpt-image-2 via the OpenAI Responses API.
 * This is the default image model for mesh mode.
 *
 * Multi-turn: when `priorImageCallId` is provided, the prior
 * image_generation_call is referenced by ID (the canonical edit pattern)
 * instead of re-encoding the image as base64. Newly uploaded references
 * (no prior call ID) fall through to input_image base64.
 *
 * Output format: jpeg. Per OpenAI's docs, jpeg is faster than png with
 * the image_generation tool, and our downstream 3D pipelines don't need
 * alpha (we also set background=opaque). Latency win.
 */
export const generateImageWithGptImage2 = async (
  supabaseClient: SupabaseClient,
  openAI: OpenAI,
  userId: string,
  conversationId: string,
  prompt: string,
  images: string[],
  priorImageCallId: string | null,
  // Quality is selected by workflow tier. Internal cost assumptions live in
  // protected admin pricing config, not in source.
  quality: GptImageQuality,
  usageCtx?: ImageUsageCtx,
  // Inpainting mask for edit mode. When provided, the mask PNG is downloaded
  // from storage, base64-encoded, and passed to the image_generation tool as
  // input_image_mask. OpenAI semantics: fully-transparent (alpha 0) areas of
  // the mask are the regions to regenerate; opaque areas are preserved.
  maskImageId?: string | null,
): Promise<GptImage2Result> => {
  const enforcedPrompt = enforce3DObjectPrompt(prompt);
  debugLog('Generating image with gpt-image-2 via Responses API', {
    userId,
    conversationId,
    prompt: enforcedPrompt,
    imagesCount: images.length,
    priorImageCallId,
    hasMask: Boolean(maskImageId),
  });

  // Download + base64-encode the inpainting mask (edit mode only). The mask
  // must match the exact pixels of the source image being edited, so callers
  // pass priorImageCallId = null in edit mode to force the base64 reference
  // path below rather than the prior-call-id shortcut.
  let maskBase64: string | null = null;
  if (maskImageId) {
    const { data: maskData } = await supabaseClient.storage
      .from('images')
      .download(`${userId}/${conversationId}/${maskImageId}`);

    if (!maskData) {
      throw new Error(`Failed to download mask ${maskImageId}`);
    }

    const maskArrayBuffer = await maskData.arrayBuffer();
    const maskBuffer = Buffer.from(maskArrayBuffer);
    maskBase64 = maskBuffer.toString('base64');
  }

  const content: Array<
    | { type: 'input_text'; text: string }
    | { type: 'input_image'; image_url: string; detail: 'auto' }
  > = [{ type: 'input_text', text: enforcedPrompt }];

  // Base64 path is only used when we have no prior gpt-image-2 call to
  // reference (e.g. a freshly uploaded user image).
  const shouldEncodeReference = !priorImageCallId && images.length > 0;

  if (shouldEncodeReference) {
    for (const imageId of images) {
      const { data: imageData } = await supabaseClient.storage
        .from('images')
        .download(`${userId}/${conversationId}/${imageId}`);

      if (!imageData) {
        throw new Error(`Failed to download image ${imageId}`);
      }

      const imageArrayBuffer = await imageData.arrayBuffer();
      const imageBuffer = Buffer.from(imageArrayBuffer);
      const base64Image = imageBuffer.toString('base64');
      const mimeType = detectImageMediaType(imageBuffer, imageData.type);

      content.push({
        type: 'input_image',
        image_url: `data:${mimeType};base64,${base64Image}`,
        detail: 'auto',
      });
    }
  }

  const input: Array<
    | { role: 'user'; content: typeof content }
    | { type: 'image_generation_call'; id: string }
  > = [];

  // Prior assistant-side image_generation_call must precede the new user
  // message so the model sees the image it produced before the edit request.
  if (priorImageCallId) {
    input.push({
      type: 'image_generation_call',
      id: priorImageCallId,
    });
  }

  input.push({ role: 'user', content });

  // Use a text-capable GPT-5 model as the Responses API orchestrator; the
  // hosted image_generation tool invokes gpt-image-2 for the actual image.
  const response = await openAI.responses.create({
    model: OPENAI_IMAGE_ORCHESTRATOR_MODEL,
    input,
    tools: [
      {
        type: 'image_generation',
        model: OPENAI_IMAGE_MODEL,
        quality,
        // Non-edit generations stay square (1024x1024). Edit mode sends the
        // source + alpha mask at their natural resolution, so we let the model
        // size the output automatically to preserve the source aspect ratio —
        // a fixed square would misalign inpainting on non-square sources.
        // 'auto' is a valid member of the SDK size union for gpt-image-2.
        size: maskBase64 ? 'auto' : '1024x1024',
        output_format: 'jpeg',
        background: 'opaque',
        moderation: 'low',
        // Inpainting: transparent regions of this mask are regenerated; the
        // rest of the image is preserved. Field shape verified against the
        // installed openai@6.38.0 SDK (Responses.Tool.ImageGeneration.
        // InputImageMask = { image_url?: string; file_id?: string }).
        ...(maskBase64
          ? {
              input_image_mask: {
                image_url: `data:image/png;base64,${maskBase64}`,
              },
            }
          : {}),
      },
    ],
    tool_choice: { type: 'image_generation' },
  });

  const imageCalls = response.output.flatMap((item) =>
    item.type === 'image_generation_call' ? [item] : [],
  );
  const latestCall = imageCalls[imageCalls.length - 1];

  if (!latestCall?.result) {
    throw new Error('No generated image data from gpt-image-2');
  }

  debugLog('Successfully generated image with gpt-image-2', {
    imageCallId: latestCall.id,
    status: latestCall.status,
  });

  if (usageCtx) {
    await logOpenAiImage({
      ...usageCtx,
      quality,
      metadata: { imageCallId: latestCall.id },
    });
  }

  return {
    imageBytes: Buffer.from(latestCall.result, 'base64'),
    imageCallId: latestCall.id,
    contentType: 'image/jpeg',
  };
};

export const generateImageWithGeminiMultiTurn = async (
  supabaseClient: SupabaseClient,
  googleGenAI: GoogleGenAI,
  userId: string,
  conversationId: string,
  prompt: string,
  images: string[],
  usageCtx?: ImageUsageCtx,
): Promise<Buffer> => {
  const enforcedPrompt = enforce3DObjectPrompt(prompt);
  debugLog('Generating image with Gemini Multi-Turn', {
    userId,
    conversationId,
    prompt: enforcedPrompt,
    imagesCount: images.length,
  });

  const imageParts: {
    inlineData: { mimeType: string; data: string };
  }[] = [];

  if (images.length > 0) {
    for (const imageId of images) {
      const { data: imageData } = await supabaseClient.storage
        .from('images')
        .download(`${userId}/${conversationId}/${imageId}`);

      if (!imageData) {
        throw new Error(`Failed to download image ${imageId}`);
      }

      const imageArrayBuffer = await imageData.arrayBuffer();
      const buffer = Buffer.from(imageArrayBuffer);
      const base64Image = buffer.toString('base64');
      const mimeType = detectImageMediaType(buffer, imageData.type);

      imageParts.push({
        inlineData: {
          mimeType,
          data: base64Image,
        },
      });
    }
  }

  // Initialize the premium image chat path.
  const chat = googleGenAI.chats.create({
    model: 'gemini-3-pro-image-preview',
    config: {
      responseModalities: [Modality.TEXT, Modality.IMAGE],
      // Search grounding is built into this endpoint and does not need to be
      // explicitly enabled as a tool for image generation.
    },
  });

  const messageContent: {
    text?: string;
    inlineData?: { mimeType: string; data: string };
  }[] = [{ text: enforcedPrompt }];
  messageContent.push(...imageParts);

  debugLog('Sending message to Gemini Multi-Turn Chat');
  const response = await chat.sendMessage({
    message: messageContent,
  });

  if (
    !response.candidates ||
    !response.candidates[0] ||
    !response.candidates[0].content ||
    !response.candidates[0].content.parts
  ) {
    throw new Error('No result from Gemini Multi-Turn');
  }

  let generatedImageData: string | undefined;

  for (const part of response.candidates[0].content.parts) {
    if (part.text) {
      debugLog('Gemini Text Response:', part.text);
    } else if (part.inlineData) {
      generatedImageData = part.inlineData.data;
    }
  }

  if (!generatedImageData) {
    throw new Error('No generated image data from Gemini Multi-Turn');
  }

  const imageBytes = Buffer.from(generatedImageData, 'base64');
  if (usageCtx) {
    await logGeminiImage({ ...usageCtx, model: 'gemini-3-pro-image-preview' });
  }
  return imageBytes;
};

export const generateImageWithFalFlux = async (
  supabaseClient: SupabaseClient,
  userId: string,
  conversationId: string,
  promptText: string,
  images: string[],
  usageCtx?: ImageUsageCtx,
) => {
  const enforcedPrompt = enforce3DObjectPrompt(promptText);
  // Extract all available images for visual context, similar to how OpenAI processes them
  const contextImages: string[] = [];

  if (images.length > 0) {
    // Process images the same way OpenAI would, but collect them for Flux
    await Promise.all(
      images.map(async (image) => {
        // First check if this image exists in storage
        const { data: exists } = await supabaseClient.storage
          .from('images')
          .exists(`${userId}/${conversationId}/${image}`);

        if (exists) {
          contextImages.push(image);
        }
      }),
    );
  }

  // Enhance the prompt with 3D instructions and context
  const enhancedPrompt =
    contextImages.length > 0
      ? `${INSTRUCTIONS_3D} Based on the provided image(s), ${enforcedPrompt}. Maintain visual consistency and style with the reference image(s).`
      : `${INSTRUCTIONS_3D} ${enforcedPrompt}`;

  let imageInputs: string[] = [];
  if (contextImages.length > 0) {
    const imageFiles = contextImages.map((image) => {
      return `${userId}/${conversationId}/${image}`;
    });

    const { data: rawImageUrls } = await supabaseClient.storage
      .from('images')
      .createSignedUrls(imageFiles, 60 * 60);

    if (!rawImageUrls) {
      throw new Error('No image URL from Flux');
    }

    imageInputs = rawImageUrls
      .filter((image) => !image.error && image.signedUrl)
      .map((image) => reformatSignedUrl(image.signedUrl));
  }

  if (imageInputs.length > 0) {
    const result = await fal.run('fal-ai/flux-pro/kontext/max/multi', {
      input: {
        prompt: enhancedPrompt,
        image_urls: imageInputs,
        safety_tolerance: '6',
      },
    });

    const imageUrl = result.data.images[0];
    const response = await fetch(imageUrl.url);
    const imageBytes = await response.arrayBuffer();
    if (usageCtx) {
      await logFalUsage({
        ...usageCtx,
        endpoint: 'fal-ai/flux-pro/kontext/max/multi',
      });
    }
    return Buffer.from(imageBytes);
  } else {
    const result = await fal.run('fal-ai/flux-pro/v1.1', {
      input: {
        prompt: enhancedPrompt,
        safety_tolerance: '6',
      },
    });

    const imageUrl = result.data.images[0];
    const response = await fetch(imageUrl.url);
    const imageBytes = await response.arrayBuffer();
    if (usageCtx) {
      await logFalUsage({ ...usageCtx, endpoint: 'fal-ai/flux-pro/v1.1' });
    }
    return Buffer.from(imageBytes);
  }
};

/**
 * Generates an image using the Lite path directly.
 * Best for initial text-to-image generation for 3D models.
 */
export const generateImageWithGeminiFlash = async (
  googleGenAI: GoogleGenAI,
  prompt: string,
  usageCtx?: ImageUsageCtx,
  model: string = GEMINI_FLASH_IMAGE_MODEL,
): Promise<Buffer> => {
  const enforcedPrompt = enforce3DObjectPrompt(prompt);
  debugLog(`Generating image with ${model}`);

  const result = await googleGenAI.models.generateContent({
    model,
    contents: [{ text: enforcedPrompt }],
    config: {
      responseModalities: [Modality.TEXT, Modality.IMAGE],
    },
  });

  if (!result.candidates?.[0]?.content?.parts) {
    throw new Error('No result from Lite image generation');
  }

  let generatedImageData: string | undefined;
  for (const part of result.candidates[0].content.parts) {
    if (part.inlineData) {
      generatedImageData = part.inlineData.data;
    }
  }

  if (!generatedImageData) {
    throw new Error('No image data from Lite image generation');
  }

  const imageBytes = Buffer.from(generatedImageData, 'base64');
  debugLog(`Successfully generated image with ${model}`);
  if (usageCtx) {
    await logGeminiImage({ ...usageCtx, model });
  }

  return imageBytes;
};

/**
 * Edits an image using the Lite path directly.
 * Best for editing existing images or uploaded images for 3D model generation.
 */
export const generateImageWithGeminiFlashEdit = async (
  googleGenAI: GoogleGenAI,
  prompt: string,
  imageUrls: string | string[],
  usageCtx?: ImageUsageCtx,
  model: string = GEMINI_FLASH_IMAGE_MODEL,
): Promise<Buffer> => {
  const enforcedPrompt = enforce3DObjectPrompt(prompt);
  debugLog(`Editing image with ${model}`);
  const normalizedImageUrls = Array.isArray(imageUrls)
    ? imageUrls
    : [imageUrls];
  debugLog('Input image URLs:', normalizedImageUrls);
  debugLog('Prompt:', enforcedPrompt);

  try {
    const imageParts = await Promise.all(
      normalizedImageUrls.map(async (imageUrl) => {
        const imageResponse = await fetch(imageUrl);
        if (!imageResponse.ok) {
          throw new Error(
            `Failed to fetch input image: ${imageResponse.status}`,
          );
        }

        const imageArrayBuffer = await imageResponse.arrayBuffer();
        const imageBuffer = Buffer.from(imageArrayBuffer);
        const base64Image = imageBuffer.toString('base64');
        const mimeType = detectImageMediaType(
          imageBuffer,
          imageResponse.headers.get('Content-Type'),
        );

        return {
          inlineData: {
            mimeType,
            data: base64Image,
          },
        };
      }),
    );

    const result = await googleGenAI.models.generateContent({
      model,
      contents: [{ text: enforcedPrompt }, ...imageParts],
      config: {
        responseModalities: [Modality.TEXT, Modality.IMAGE],
      },
    });

    if (!result.candidates?.[0]?.content?.parts) {
      throw new Error('No result from Lite image edit');
    }

    let generatedImageData: string | undefined;
    for (const part of result.candidates[0].content.parts) {
      if (part.inlineData) {
        generatedImageData = part.inlineData.data;
      }
    }

    if (!generatedImageData) {
      throw new Error('No image data from Lite image edit');
    }

    const imageBytes = Buffer.from(generatedImageData, 'base64');
    debugLog(`Successfully edited image with ${model}`);
    if (usageCtx) {
      await logGeminiImage({ ...usageCtx, model });
    }

    return imageBytes;
  } catch (error) {
    debugLog('Error in generateImageWithGeminiFlashEdit:', error);
    throw error;
  }
};
