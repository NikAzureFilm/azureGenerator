import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { GoogleGenAI } from 'npm:@google/genai';
import {
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
    } = await req.json();

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

    const generateWithLite = async (): Promise<Buffer> => {
      if (primaryRefImageId) {
        const refPaths = referenceIds.map(
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
          builtPrompt,
          signedRefUrls,
          imageUsageCtx,
        );
      }

      return await generateImageWithGeminiFlash(
        googleGenAI,
        builtPrompt,
        imageUsageCtx,
      );
    };

    const generateWithNormalOrLite = async (): Promise<Buffer> => {
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
        console.warn('Normal image generation failed; falling back to Lite.');
        return await generateWithLite();
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
          null,
          getOpenAiImageGenerationQuality(selectedImageGenerationModel),
          imageUsageCtx,
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
          'Premium image generation failed; falling back to Normal.',
        );
        imageBytes = await generateWithNormalOrLite();
      }
    } else if (selectedProvider === 'nano-banana-pro') {
      imageBytes = await generateWithNormalOrLite();
    } else {
      imageBytes = await generateWithLite();
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
