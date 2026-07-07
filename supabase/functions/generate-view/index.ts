import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { GoogleGenAI } from 'npm:@google/genai';
import {
  GEMINI_FLASH_LITE_IMAGE_MODEL,
  generateImageWithGeminiFlash,
  generateImageWithGeminiFlashEdit,
  generateImageWithGeminiMultiTurn,
  generateImageWithGptImage2,
} from '../_shared/imageGen.ts';
import {
  getServiceRoleSupabaseClient,
  getAnonSupabaseClient,
} from '../_shared/supabaseClient.ts';
import { reformatSignedUrl } from '../_shared/messageUtils.ts';
import { detectImageMediaType } from '../_shared/imageMime.ts';
import { initSentry, logError } from '../_shared/sentry.ts';
import { billing, BillingClientError } from '../_shared/billingClient.ts';
import {
  getBodySizeBytes,
  recordGeneratedAsset,
} from '../_shared/generatedAssets.ts';
import {
  RefundableTokenLedger,
  type RefundFailure,
} from '../_shared/refundableTokenLedger.ts';
import {
  getImageGenerationProvider,
  getImageGenerationTokenCost,
  getOpenAiImageGenerationQuality,
  normalizeImageGenerationModel,
  type ImageGenerationModel,
  type ImageGenerationProvider,
} from '../../../shared/imageGeneration.ts';
import { Buffer } from 'node:buffer';
import OpenAI from 'npm:openai@^6.34.0';
import {
  buildImageGenerationPrompt,
  VIEW_DIRECTIVE,
  type ImageGenerationMode,
  type ViewLabel,
} from '../_shared/viewPrompt.ts';

initSentry();

const DEBUG_LOGS =
  Deno.env.get('ENVIRONMENT') === 'local' ||
  Deno.env.get('DEBUG_LOGS') === 'true';
const debugLog = (...args: unknown[]) => {
  if (DEBUG_LOGS) console.log(...args);
};

const googleGenAI = new GoogleGenAI({
  apiKey: Deno.env.get('GOOGLE_API_KEY')?.trim() ?? '',
});

const openAI = new OpenAI({
  apiKey: Deno.env.get('OPENAI_API_KEY')?.trim() ?? '',
});

const logRefundFailure = ({ error, charge }: RefundFailure) => {
  logError(error, {
    functionName: 'generate-view',
    statusCode: 502,
    userId: charge.body.userId,
    additionalContext: {
      stage: 'refund_after_generation_error',
      operation: charge.body.operation,
      referenceId: charge.body.referenceId,
      tokens: charge.body.tokens,
    },
  });
};

Deno.serve(async (req) => {
  const tokenLedger = new RefundableTokenLedger(billing);
  try {
    if (req.method === 'OPTIONS') {
      return new Response('ok', { headers: corsHeaders });
    }

    if (req.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const authedClient = getAnonSupabaseClient({
      global: {
        headers: { Authorization: req.headers.get('Authorization') ?? '' },
      },
    });

    const { data: userData, error: userError } =
      await authedClient.auth.getUser();

    if (userError || !userData.user) {
      return new Response(
        JSON.stringify({ error: { message: 'Unauthorized' } }),
        {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
    }

    const serviceClient = getServiceRoleSupabaseClient();

    const {
      prompt,
      view,
      conversationId,
      refImageId,
      refImageIds,
      refImageLabels,
      provider,
      imageGenerationModel,
      mode = 'input',
      maskImageId,
      markedImageId,
    }: {
      prompt?: string;
      view?: ViewLabel;
      conversationId?: string;
      refImageId?: string;
      refImageIds?: string[];
      refImageLabels?: string[];
      provider?: ImageGenerationProvider;
      imageGenerationModel?: ImageGenerationModel;
      mode?: ImageGenerationMode;
      // Edit mode (brush inpainting) only.
      maskImageId?: string;
      markedImageId?: string;
    } = await req.json();

    const isEditMode = mode === 'edit';

    const referenceIds: string[] = (() => {
      if (Array.isArray(refImageIds) && refImageIds.length > 0) {
        return refImageIds.filter(
          (id): id is string => typeof id === 'string' && id.length > 0,
        );
      }
      return refImageId ? [refImageId] : [];
    })();
    const primaryRefImageId = referenceIds[0];

    if (!conversationId) {
      return new Response(
        JSON.stringify({ error: { message: 'conversationId required' } }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
    }

    if (!view || !(view in VIEW_DIRECTIVE)) {
      return new Response(
        JSON.stringify({ error: { message: 'invalid view label' } }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
    }

    const userPrompt = (prompt ?? '').trim();
    if (!userPrompt && referenceIds.length === 0) {
      return new Response(
        JSON.stringify({
          error: { message: 'prompt or refImageId required' },
        }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
    }

    // Edit (brush inpainting) mode requires the instruction, the source image
    // to edit, plus both mask artifacts (alpha mask for OpenAI, red-marked
    // composite for the Gemini fallback path).
    if (isEditMode) {
      if (!userPrompt) {
        return new Response(
          JSON.stringify({ error: { message: 'prompt required for edit' } }),
          {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          },
        );
      }
      if (referenceIds.length === 0) {
        return new Response(
          JSON.stringify({
            error: { message: 'source refImageId required for edit' },
          }),
          {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          },
        );
      }
      if (!maskImageId || !markedImageId) {
        return new Response(
          JSON.stringify({
            error: {
              message: 'maskImageId and markedImageId required for edit',
            },
          }),
          {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          },
        );
      }
    }

    const userId = userData.user.id;
    const imageId = crypto.randomUUID();
    const imageUsageCtx = {
      functionName: 'generate-view',
      operation: 'image',
      userId,
      conversationId,
      referenceId: imageId,
    };
    const selectedImageGenerationModel = normalizeImageGenerationModel(
      imageGenerationModel ?? provider,
    );
    const selectedProvider = getImageGenerationProvider(
      selectedImageGenerationModel,
    );
    const builtPrompt = buildImageGenerationPrompt({
      view,
      userPrompt,
      hasReference: referenceIds.length > 0,
      mode,
      referenceLabels: Array.isArray(refImageLabels) ? refImageLabels : [],
    });
    const tokenCost = getImageGenerationTokenCost(selectedImageGenerationModel);

    if (!userData.user.email) {
      return new Response(
        JSON.stringify({ error: { message: 'User email missing' } }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
    }

    try {
      const consumeResult = await tokenLedger.consume(userData.user.email, {
        tokens: tokenCost,
        operation: 'chat',
        referenceId: imageId,
        userId,
      });
      if (!consumeResult.ok) {
        return new Response(
          JSON.stringify({
            error: {
              message: 'insufficient_tokens',
              code: 'insufficient_tokens',
              tokensRequired: consumeResult.tokensRequired,
              tokensAvailable: consumeResult.tokensAvailable,
            },
          }),
          {
            status: 402,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          },
        );
      }
    } catch (err) {
      const status = err instanceof BillingClientError ? err.status : 502;
      logError(err, {
        functionName: 'generate-view',
        statusCode: status,
        userId,
      });
      return new Response(
        JSON.stringify({ error: { message: 'billing_unavailable' } }),
        {
          status: 502,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
    }

    debugLog('generate-view', {
      view,
      hasRef: referenceIds.length > 0,
      refCount: referenceIds.length,
      provider: selectedProvider,
      imageGenerationModel: selectedImageGenerationModel,
      tokenCost,
      mode,
    });

    // Gemini edit-mode note. Gemini gets the original render plus a copy with
    // the regions-to-change painted in translucent red (it has no alpha-mask
    // channel like OpenAI), so we spell out how to read the two images.
    const geminiEditPrompt = `${builtPrompt} Image 1 is the original render. Image 2 is the identical render with the regions to change painted in translucent red. Output the edited version of image 1: change ONLY the red-marked regions as instructed, remove all red markings from the output, and reproduce everything else pixel-faithfully.`;

    const generateWithNormal = async (): Promise<Buffer> => {
      return await generateImageWithGeminiMultiTurn(
        serviceClient,
        googleGenAI,
        userId,
        conversationId,
        builtPrompt,
        referenceIds,
        imageUsageCtx,
      );
    };

    // Shared Gemini Flash path; the model decides the tier — Nano Banana 2
    // by default, Nano Banana 2 Lite when the lite model id is passed. In edit
    // mode the input images are [source, marked-composite] and the prompt
    // carries the red-marking instructions.
    const generateWithFlash = async (flashModel?: string): Promise<Buffer> => {
      const flashRefIds =
        isEditMode && markedImageId
          ? [primaryRefImageId, markedImageId]
          : referenceIds;
      const flashPrompt = isEditMode ? geminiEditPrompt : builtPrompt;

      if (primaryRefImageId) {
        const refPaths = flashRefIds.map(
          (refId) => `${userId}/${conversationId}/${refId}`,
        );
        const { data: signedRefs, error: signedRefError } =
          await serviceClient.storage
            .from('images')
            .createSignedUrls(refPaths, 60 * 60);
        const signedRefUrls =
          signedRefs
            ?.filter((signedRef) => !signedRef.error && signedRef.signedUrl)
            .map((signedRef) => reformatSignedUrl(signedRef.signedUrl)) ?? [];
        if (signedRefError || signedRefUrls.length === 0) {
          throw new Error(
            `Failed to sign reference image: ${signedRefError?.message ?? 'unknown'}`,
          );
        }
        return await generateImageWithGeminiFlashEdit(
          googleGenAI,
          flashPrompt,
          signedRefUrls,
          imageUsageCtx,
          flashModel,
        );
      }

      return await generateImageWithGeminiFlash(
        googleGenAI,
        builtPrompt,
        imageUsageCtx,
        flashModel,
      );
    };

    const generateWithNanoBanana2 = () => generateWithFlash();
    const generateWithNanoLite = () =>
      generateWithFlash(GEMINI_FLASH_LITE_IMAGE_MODEL);

    const generateWithNanoBanana2OrLite = async (): Promise<Buffer> => {
      try {
        return await generateWithNanoBanana2();
      } catch (error) {
        logError(error, {
          functionName: 'generate-view',
          statusCode: 500,
          userId,
          conversationId,
          additionalContext: {
            stage: 'nano_banana_2_fallback',
            view,
            refCount: referenceIds.length,
            mode,
          },
        });
        console.warn(
          'Nano Banana 2 image generation failed; falling back to Nano Banana 2 Lite.',
        );
        return await generateWithNanoLite();
      }
    };

    // Legacy Normal tier requests (nano-banana-pro) keep their own chain.
    // Edit mode has no multi-turn equivalent (it needs the marked composite),
    // so we route nano-banana-pro edits to the Nano Banana 2 flash edit path.
    const generateWithNormalOrLite = async (): Promise<Buffer> => {
      if (isEditMode) {
        return await generateWithNanoBanana2OrLite();
      }
      try {
        return await generateWithNormal();
      } catch (error) {
        logError(error, {
          functionName: 'generate-view',
          statusCode: 500,
          userId,
          conversationId,
          additionalContext: {
            stage: 'nano_banana_pro_fallback',
            view,
            refCount: referenceIds.length,
            mode,
          },
        });
        console.warn(
          'Normal image generation failed; falling back to Nano Banana 2.',
        );
        return await generateWithNanoBanana2OrLite();
      }
    };

    let imageBytes: Buffer;
    let contentType: string | undefined;
    let imageGenerationCallId: string | null = null;
    if (selectedProvider === 'openai') {
      try {
        const result = await generateImageWithGptImage2(
          serviceClient,
          openAI,
          userId,
          conversationId,
          builtPrompt,
          referenceIds,
          // Edit mode must re-encode the source as base64 so the alpha mask
          // matches the exact pixels being edited; never use the prior-call-id
          // shortcut here.
          null,
          getOpenAiImageGenerationQuality(selectedImageGenerationModel),
          imageUsageCtx,
          isEditMode ? maskImageId : null,
        );
        imageBytes = result.imageBytes;
        contentType = result.contentType;
        imageGenerationCallId = result.imageCallId;
      } catch (error) {
        logError(error, {
          functionName: 'generate-view',
          statusCode: 500,
          userId,
          conversationId,
          additionalContext: {
            stage: 'gpt_image_2_fallback',
            view,
            refCount: referenceIds.length,
            mode,
            imageGenerationModel: selectedImageGenerationModel,
          },
        });
        console.warn(
          'Image Gen 2 generation failed; falling back to Nano Banana 2.',
        );
        imageBytes = await generateWithNanoBanana2OrLite();
      }
    } else if (selectedProvider === 'nano-banana-pro') {
      imageBytes = await generateWithNormalOrLite();
    } else if (selectedProvider === 'nano-banana-lite') {
      imageBytes = await generateWithNanoLite();
    } else {
      imageBytes = await generateWithNanoBanana2OrLite();
    }

    const path = `${userId}/${conversationId}/${imageId}`;
    contentType = contentType ?? detectImageMediaType(imageBytes);
    const { error: uploadError } = await serviceClient.storage
      .from('images')
      .upload(path, imageBytes, { contentType });

    if (uploadError) {
      throw new Error(`Upload failed: ${uploadError.message}`);
    }

    const imagePrompt = {
      text: userPrompt || builtPrompt,
      generated: true,
      source: 'generate-view',
      view,
      mode,
      provider: selectedProvider,
      imageGenerationModel: selectedImageGenerationModel,
      tokenCost,
      ...(referenceIds.length > 0 && { images: referenceIds }),
      ...(Array.isArray(refImageLabels) &&
        refImageLabels.length > 0 && { refImageLabels }),
      ...(isEditMode && maskImageId && { maskImageId }),
      ...(isEditMode && markedImageId && { markedImageId }),
    };

    const { error: imageRowError } = await serviceClient.from('images').upsert(
      {
        id: imageId,
        status: 'success',
        user_id: userId,
        conversation_id: conversationId,
        image_generation_call_id: imageGenerationCallId,
        prompt: imagePrompt,
      },
      { onConflict: 'id' },
    );

    if (imageRowError) {
      throw new Error(`Image row insert failed: ${imageRowError.message}`);
    }

    await recordGeneratedAsset({
      supabaseClient: serviceClient,
      userId,
      conversationId,
      sourceTable: 'images',
      sourceId: imageId,
      kind: 'image',
      bucket: 'images',
      objectKey: path,
      mimeType: contentType,
      sizeBytes: getBodySizeBytes(imageBytes),
      metadata: {
        source: 'generate-view',
        view,
        mode,
        provider: selectedProvider,
        imageGenerationModel: selectedImageGenerationModel,
        tokenCost,
      },
    });

    const { data: signedUploaded, error: signedUploadedError } =
      await serviceClient.storage.from('images').createSignedUrl(path, 60 * 60);

    if (signedUploadedError || !signedUploaded?.signedUrl) {
      throw new Error(
        `Sign upload failed: ${signedUploadedError?.message ?? 'unknown'}`,
      );
    }

    return new Response(
      JSON.stringify({
        id: imageId,
        url: reformatSignedUrl(signedUploaded.signedUrl),
      }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      },
    );
  } catch (error) {
    console.error('generate-view failed:', error);
    await tokenLedger.refundAll(logRefundFailure);
    logError(error instanceof Error ? error : new Error(String(error)), {
      functionName: 'generate-view',
      statusCode: 500,
    });
    return new Response(
      JSON.stringify({
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      },
    );
  }
});
