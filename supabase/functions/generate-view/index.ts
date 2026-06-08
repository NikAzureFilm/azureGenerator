import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { GoogleGenAI } from 'npm:@google/genai';
import {
  generateImageWithGeminiFlash,
  generateImageWithGeminiFlashEdit,
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
  RefundableTokenLedger,
  type RefundFailure,
} from '../_shared/refundableTokenLedger.ts';
import { FEATURE_COSTS } from '../../../shared/tokenCosts.ts';
import { getImageGenerationTokenCost } from '../../../shared/imageGeneration.ts';
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
      mode = 'input',
    }: {
      prompt?: string;
      view?: ViewLabel;
      conversationId?: string;
      refImageId?: string;
      refImageIds?: string[];
      refImageLabels?: string[];
      provider?: 'openai' | 'nano-banana';
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
    const imageUsageCtx = {
      functionName: 'generate-view',
      operation: 'image',
      userId,
      conversationId,
    };
    const shouldUseOpenAi = provider === 'openai';
    const builtPrompt = buildImageGenerationPrompt({
      view,
      userPrompt,
      hasReference: referenceIds.length > 0,
      mode,
      referenceLabels: Array.isArray(refImageLabels) ? refImageLabels : [],
    });
    const tokenCost = shouldUseOpenAi
      ? FEATURE_COSTS.generatedInputImage.tokens
      : getImageGenerationTokenCost('nano-banana-2');

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
        referenceId: crypto.randomUUID(),
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
      provider: shouldUseOpenAi ? 'openai' : 'nano-banana',
      tokenCost,
      mode,
    });

    const generateWithNanoBanana = async (): Promise<Buffer> => {
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

    let imageBytes: Buffer;
    let contentType: string | undefined;
    if (shouldUseOpenAi) {
      try {
        const result = await generateImageWithGptImage2(
          serviceClient,
          openAI,
          userId,
          conversationId,
          builtPrompt,
          referenceIds,
          null,
          // Supabase Edge Functions have a 150s idle timeout. High quality
          // gpt-image-2 calls can exceed that for synchronous view generation.
          'low',
          imageUsageCtx,
        );
        imageBytes = result.imageBytes;
        contentType = result.contentType;
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
          },
        });
        console.warn(
          'OpenAI image generation failed; falling back to Nano Banana.',
        );
        imageBytes = await generateWithNanoBanana();
      }
    } else {
      imageBytes = await generateWithNanoBanana();
    }

    const imageId = crypto.randomUUID();
    const path = `${userId}/${conversationId}/${imageId}`;
    contentType = contentType ?? detectImageMediaType(imageBytes);
    const { error: uploadError } = await serviceClient.storage
      .from('images')
      .upload(path, imageBytes, { contentType });

    if (uploadError) {
      throw new Error(`Upload failed: ${uploadError.message}`);
    }

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
