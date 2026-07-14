import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { fal } from 'npm:@fal-ai/client';
import { GoogleGenAI } from 'npm:@google/genai';
import Anthropic from 'npm:@anthropic-ai/sdk';
import OpenAI from 'npm:openai@^6.34.0';
import {
  generateImageWithFalFlux,
  generateImageWithGeminiFlash,
  generateImageWithGeminiFlashEdit,
  generateImageWithGeminiMultiTurn,
  generateImageWithGptImage2,
  INSTRUCTIONS_3D as instructions3D,
  type GptImageQuality,
} from '../_shared/imageGen.ts';
import {
  Model,
  MeshFileType,
  type MultiviewImages,
  type SemanticMaterialMap,
} from '@shared/types.ts';
import {
  getImageGenerationProvider,
  getOpenAiImageGenerationQuality,
  normalizeImageGenerationModel,
  type ImageGenerationModel,
} from '../../../shared/imageGeneration.ts';
import {
  FEATURE_COSTS,
  getCreativeModelTokenCost,
} from '../../../shared/tokenCosts.ts';
import { logFalUsage } from '../_shared/providerUsage.ts';
import {
  FAL_FIXED_CALL_USD,
  HUNYUAN_PRO_MULTIVIEW_UNITS,
  HUNYUAN_PRO_UPSCALE_UNITS,
} from '../../../shared/providerPricing.ts';
import {
  getServiceRoleSupabaseClient,
  SupabaseClient,
} from '../_shared/supabaseClient.ts';
import { reformatSignedUrl } from '../_shared/messageUtils.ts';
import { detectImageMediaType } from '../_shared/imageMime.ts';
import { billing, BillingClientError } from '../_shared/billingClient.ts';
import {
  getBodySizeBytes,
  recordGeneratedAsset,
} from '../_shared/generatedAssets.ts';
import {
  checkGenerationCostControls,
  costControlErrorBody,
} from '../_shared/costControls.ts';
import {
  DeferredTokenLedger,
  type ReservationFailure,
} from '../_shared/deferredTokenLedger.ts';
import { initSentry, logError, logApiError } from '../_shared/sentry.ts';
import { Buffer } from 'node:buffer';

declare const EdgeRuntime: {
  waitUntil(promise: Promise<unknown>): void;
};

// Initialize Sentry for error logging
initSentry();

// Constants
const TEXTURELESS_MAX_POLYGONS = 50000;

const DEBUG_LOGS =
  Deno.env.get('ENVIRONMENT') === 'local' ||
  Deno.env.get('DEBUG_LOGS') === 'true';
const debugLog = (...args: unknown[]) => {
  if (DEBUG_LOGS) console.log(...args);
};

const logReservationFailure = ({ error, charge }: ReservationFailure) => {
  logError(error, {
    functionName: 'mesh',
    statusCode: 502,
    userId: charge.body.userId,
    additionalContext: {
      stage: 'release_reservation_after_mesh_error',
      operation: charge.body.operation,
      referenceId: charge.body.referenceId,
      tokens: charge.body.tokens,
    },
  });
};

const QUALITY_CAPTION_TIMEOUT_MS = 10000;
const QUALITY_GENERICIZE_TIMEOUT_MS = 5000;
const QUALITY_MASK_TIMEOUT_MS = 10000;
const MAX_QUALITY_IMAGE_TO_3D_ENDPOINT = 'fal-ai/meshy/v6-preview/image-to-3d';
const MAX_QUALITY_TARGET_POLYCOUNT = 300000;
const HUNYUAN_3D_PRO_IMAGE_TO_3D_ENDPOINT =
  'fal-ai/hunyuan-3d/v3.1/pro/image-to-3d';
const MULTIVIEW_SLOTS = ['front', 'left', 'back', 'right'] as const;

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

// Records the actual fal $ cost for a mesh generation. Reads the owning
// user/conversation from the mesh row so callers only need the meshId.
async function logFalMeshCost(
  supabaseClient: SupabaseClient,
  meshId: string,
  endpoint: string,
  opts: {
    operation?: string;
    units?: number;
    costUsd?: number;
    falRequestId?: string;
  } = {},
) {
  const { data: meshRow } = await supabaseClient
    .from('meshes')
    .select('user_id, conversation_id')
    .eq('id', meshId)
    .maybeSingle();
  await logFalUsage({
    functionName: 'mesh',
    operation: opts.operation ?? 'mesh',
    endpoint,
    units: opts.units,
    costUsd: opts.costUsd,
    falRequestId: opts.falRequestId,
    userId: meshRow?.user_id ?? null,
    conversationId: meshRow?.conversation_id ?? null,
    referenceId: meshId,
  });
}

async function recordGeneratedImageAsset({
  supabaseClient,
  userId,
  conversationId,
  imageId,
  body,
  contentType,
  metadata,
}: {
  supabaseClient: SupabaseClient;
  userId: string;
  conversationId: string;
  imageId: string;
  body: unknown;
  contentType?: string | null;
  metadata?: Record<string, unknown>;
}) {
  await recordGeneratedAsset({
    supabaseClient,
    userId,
    conversationId,
    sourceTable: 'images',
    sourceId: imageId,
    kind: 'image',
    bucket: 'images',
    objectKey: `${userId}/${conversationId}/${imageId}`,
    mimeType: contentType ?? null,
    sizeBytes: getBodySizeBytes(body),
    metadata: metadata ?? {},
  });
}

async function recordFalQueueRequest(
  supabaseClient: SupabaseClient,
  meshId: string,
  endpoint: string,
  submission: unknown,
  units = 1,
) {
  const requestId =
    submission &&
    typeof submission === 'object' &&
    'request_id' in submission &&
    typeof submission.request_id === 'string'
      ? submission.request_id
      : null;

  // Always record the actual fal $ cost for this generation, independent of
  // the request_id bookkeeping below.
  await logFalMeshCost(supabaseClient, meshId, endpoint, {
    units,
    falRequestId: requestId ?? undefined,
  });

  if (!requestId) {
    debugLog('FAL submit response did not include request_id', {
      endpoint,
      meshId,
      submission,
    });
    return;
  }

  const { data: meshRow, error: selectError } = await supabaseClient
    .from('meshes')
    .select('prompt')
    .eq('id', meshId)
    .maybeSingle();

  if (selectError) {
    debugLog('Failed to read mesh prompt for FAL request tracking', {
      meshId,
      endpoint,
      error: selectError.message,
    });
    return;
  }

  const prompt =
    meshRow?.prompt && typeof meshRow.prompt === 'object'
      ? (meshRow.prompt as Record<string, unknown>)
      : {};

  await supabaseClient
    .from('meshes')
    .update({
      prompt: {
        ...prompt,
        fal: {
          endpoint,
          request_id: requestId,
          submitted_at: new Date().toISOString(),
        },
      },
    })
    .eq('id', meshId);
}

// Returns the image_generation_call_id to thread into the next gpt-image-2
// call, or null when the prior image was produced by a fallback (Gemini/Flux)
// and has no call ID.
//
// Branch-aware: when the user is editing a specific mesh (via the `mesh`
// request param), we prefer that mesh's latest image — otherwise a global
// "most recent in conversation" lookup would grab a sibling-branch image the
// user isn't looking at, and gpt-image-2 would silently edit the wrong
// output. Without a specific mesh in focus, fall back to conversation-wide
// latest (linear editing flow).
//
// We do NOT filter for non-null call IDs: if the last turn fell back,
// skipping its null row and surfacing an older gpt-image-2 call ID would
// make gpt-image-2 edit an image two turns ago while the user is looking
// at the fallback output.
async function getPriorImageCallId(
  supabaseClient: SupabaseClient,
  userId: string,
  conversationId: string,
  preferMeshId: string | undefined,
): Promise<string | null> {
  if (preferMeshId) {
    // CRITICAL: filter by user_id + conversation_id here. preferMeshId comes
    // from the untrusted request body, and the service-role client bypasses
    // RLS. Without this filter, a user could pass another user's mesh UUID
    // to thread the victim's OpenAI multi-turn continuity ID into their own
    // gpt-image-2 call.
    const { data: meshRow } = await supabaseClient
      .from('meshes')
      .select('images')
      .eq('id', preferMeshId)
      .eq('user_id', userId)
      .eq('conversation_id', conversationId)
      .maybeSingle();
    const meshImageIds = Array.isArray(meshRow?.images)
      ? (meshRow.images as string[])
      : [];
    if (meshImageIds.length > 0) {
      const { data } = await supabaseClient
        .from('images')
        .select('image_generation_call_id')
        .in('id', meshImageIds)
        .eq('user_id', userId)
        .eq('conversation_id', conversationId)
        .eq('status', 'success')
        .order('created_at', { ascending: false })
        .limit(1);
      return data?.[0]?.image_generation_call_id ?? null;
    }
  }

  const { data } = await supabaseClient
    .from('images')
    .select('image_generation_call_id')
    .eq('conversation_id', conversationId)
    .eq('user_id', userId)
    .eq('status', 'success')
    .order('created_at', { ascending: false })
    .limit(1);

  return data?.[0]?.image_generation_call_id ?? null;
}

// Unified mesh-image generation. Every mesh mode goes through this helper:
//   1. Primary premium path, including multi-turn image_generation_call support
//   2. First fallback path
//   3. Second fallback path
//
// The fallback image path also powers mesh previews (see submitPreviewJob),
// which intentionally does not go through this chain.
// Per-mode image quality. Fast mode defaults to `low` since fast-mode
// output is inherently draft quality. Quality/ultra use `high` for final seed
// fidelity. Internal cost assumptions live in protected admin pricing config.
const QUALITY_BY_MESH_MODEL: Record<
  'fast' | 'quality' | 'ultra',
  GptImageQuality
> = {
  fast: 'low',
  quality: 'high',
  ultra: 'high',
};

async function generateMeshImage(
  userId: string,
  conversationId: string,
  prompt: string,
  // Fresh references uploaded in *this* turn — take precedence for base64.
  freshUserImages: string[],
  // All available reference images in the conversation (includes mesh
  // previews and prior mesh images) — used when no fresh upload.
  allImages: string[],
  // The specific mesh the user is editing from (branch anchor), if any.
  // Makes the multi-turn lookup branch-aware.
  priorMeshId: string | undefined,
  imageGenerationModel: ImageGenerationModel | undefined,
  sentryStage: { meshModel: 'fast' | 'quality' | 'ultra'; subStage?: string },
  generatedImageId?: string,
): Promise<{
  imageBytes: Buffer;
  imageCallId: string | null;
  contentType: 'image/jpeg' | 'image/png';
}> {
  const hasFreshUserImages = freshUserImages.length > 0;
  // Skip the call-id lookup when the user is providing fresh reference
  // material — we want gpt-image-2 to anchor on the new upload, not a
  // prior turn's output.
  let priorImageCallId: string | null;
  // Tri-state for observability so Sentry breadcrumbs distinguish
  // "threaded a prior id", "no prior existed" (or prior was a fallback),
  // and "prior existed but we suppressed it because the user uploaded
  // fresh reference material this turn".
  let priorImageCallIdStatus:
    | 'threaded'
    | 'none_available'
    | 'suppressed_by_fresh_upload';
  if (hasFreshUserImages) {
    priorImageCallId = null;
    priorImageCallIdStatus = 'suppressed_by_fresh_upload';
  } else {
    priorImageCallId = await getPriorImageCallId(
      supabaseClient,
      userId,
      conversationId,
      priorMeshId,
    );
    priorImageCallIdStatus =
      priorImageCallId !== null ? 'threaded' : 'none_available';
  }
  const gptImageReferenceImages = hasFreshUserImages
    ? freshUserImages
    : allImages;

  const sentryContext = {
    functionName: 'mesh' as const,
    statusCode: 500,
    userId,
    conversationId,
  };
  const selectedImageGenerationModel =
    normalizeImageGenerationModel(imageGenerationModel);
  const selectedProvider = getImageGenerationProvider(
    selectedImageGenerationModel,
  );
  let openAiQuality: GptImageQuality =
    QUALITY_BY_MESH_MODEL[sentryStage.meshModel];

  const imageUsageCtx = {
    functionName: 'mesh',
    operation: 'image',
    userId,
    conversationId,
    referenceId: generatedImageId,
  };

  let provider: 'gpt-image-2' | 'nano-banana-pro' | 'nano-banana' | 'flux';
  let result: {
    imageBytes: Buffer;
    imageCallId: string | null;
    contentType: 'image/jpeg' | 'image/png';
  };

  const generateGeminiProResult = async () => {
    const imageBytes = await generateImageWithGeminiMultiTurn(
      supabaseClient,
      googleGenAI,
      userId,
      conversationId,
      prompt,
      gptImageReferenceImages,
      imageUsageCtx,
    );
    return {
      imageBytes,
      imageCallId: null,
      contentType: 'image/png' as const,
    };
  };

  const generateGeminiFlashResult = async () => {
    if (gptImageReferenceImages.length > 0) {
      const refPaths = gptImageReferenceImages.map(
        (imageId) => `${userId}/${conversationId}/${imageId}`,
      );
      const { data: signedRefs, error: signedRefError } =
        await supabaseClient.storage
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

      const imageBytes = await generateImageWithGeminiFlashEdit(
        googleGenAI,
        prompt,
        signedRefUrls,
        imageUsageCtx,
      );
      return {
        imageBytes,
        imageCallId: null,
        contentType: 'image/png' as const,
      };
    }

    const imageBytes = await generateImageWithGeminiFlash(
      googleGenAI,
      prompt,
      imageUsageCtx,
    );
    return {
      imageBytes,
      imageCallId: null,
      contentType: 'image/png' as const,
    };
  };

  if (selectedProvider === 'openai') {
    try {
      openAiQuality = getOpenAiImageGenerationQuality(
        selectedImageGenerationModel,
      );
      result = await generateImageWithGptImage2(
        supabaseClient,
        openAI,
        userId,
        conversationId,
        prompt,
        gptImageReferenceImages,
        priorImageCallId,
        openAiQuality,
        imageUsageCtx,
      );
      provider = 'gpt-image-2';
    } catch (gptImageError) {
      logError(gptImageError, {
        ...sentryContext,
        additionalContext: {
          stage: 'gpt_image_2_fallback',
          selectedImageGenerationModel,
          hasFreshUserImages,
          priorImageCallIdStatus,
          ...sentryStage,
        },
      });
      try {
        result = await generateGeminiProResult();
        provider = 'nano-banana-pro';
      } catch (geminiError) {
        logError(geminiError, {
          ...sentryContext,
          additionalContext: {
            stage: 'nano_banana_pro_fallback',
            selectedImageGenerationModel,
            hasFreshUserImages,
            priorImageCallIdStatus,
            ...sentryStage,
          },
        });
        try {
          result = await generateGeminiFlashResult();
          provider = 'nano-banana';
        } catch (flashError) {
          logError(flashError, {
            ...sentryContext,
            additionalContext: {
              stage: 'nano_banana_flash_fallback',
              selectedImageGenerationModel,
              hasFreshUserImages,
              priorImageCallIdStatus,
              ...sentryStage,
            },
          });
          try {
            const imageBytes = await generateImageWithFalFlux(
              supabaseClient,
              userId,
              conversationId,
              prompt,
              gptImageReferenceImages,
              imageUsageCtx,
            );
            // Flux returns png per its output_format config.
            result = {
              imageBytes,
              imageCallId: null,
              contentType: 'image/png',
            };
            provider = 'flux';
          } catch (fluxError) {
            logError(fluxError, {
              ...sentryContext,
              additionalContext: {
                stage: 'flux_fallback',
                selectedImageGenerationModel,
                hasFreshUserImages,
                priorImageCallIdStatus,
                ...sentryStage,
              },
            });
            throw fluxError;
          }
        }
      }
    }
  } else if (selectedProvider === 'nano-banana-pro') {
    try {
      result = await generateGeminiProResult();
      provider = 'nano-banana-pro';
    } catch (geminiError) {
      logError(geminiError, {
        ...sentryContext,
        additionalContext: {
          stage: 'nano_banana_pro_primary',
          selectedImageGenerationModel,
          hasFreshUserImages,
          priorImageCallIdStatus,
          ...sentryStage,
        },
      });
      try {
        result = await generateGeminiFlashResult();
        provider = 'nano-banana';
      } catch (flashError) {
        logError(flashError, {
          ...sentryContext,
          additionalContext: {
            stage: 'nano_banana_flash_fallback',
            selectedImageGenerationModel,
            hasFreshUserImages,
            priorImageCallIdStatus,
            ...sentryStage,
          },
        });
        try {
          result = await generateImageWithGptImage2(
            supabaseClient,
            openAI,
            userId,
            conversationId,
            prompt,
            gptImageReferenceImages,
            priorImageCallId,
            openAiQuality,
            imageUsageCtx,
          );
          provider = 'gpt-image-2';
        } catch (gptImageError) {
          logError(gptImageError, {
            ...sentryContext,
            additionalContext: {
              stage: 'gpt_image_2_fallback',
              selectedImageGenerationModel,
              hasFreshUserImages,
              priorImageCallIdStatus,
              ...sentryStage,
            },
          });
          throw gptImageError;
        }
      }
    }
  } else {
    try {
      result = await generateGeminiFlashResult();
      provider = 'nano-banana';
    } catch (flashError) {
      logError(flashError, {
        ...sentryContext,
        additionalContext: {
          stage: 'nano_banana_flash_primary',
          selectedImageGenerationModel,
          hasFreshUserImages,
          priorImageCallIdStatus,
          ...sentryStage,
        },
      });
      try {
        result = await generateGeminiProResult();
        provider = 'nano-banana-pro';
      } catch (geminiError) {
        logError(geminiError, {
          ...sentryContext,
          additionalContext: {
            stage: 'nano_banana_pro_fallback',
            selectedImageGenerationModel,
            hasFreshUserImages,
            priorImageCallIdStatus,
            ...sentryStage,
          },
        });
        try {
          result = await generateImageWithGptImage2(
            supabaseClient,
            openAI,
            userId,
            conversationId,
            prompt,
            gptImageReferenceImages,
            priorImageCallId,
            openAiQuality,
            imageUsageCtx,
          );
          provider = 'gpt-image-2';
        } catch (gptImageError) {
          logError(gptImageError, {
            ...sentryContext,
            additionalContext: {
              stage: 'gpt_image_2_fallback',
              selectedImageGenerationModel,
              hasFreshUserImages,
              priorImageCallIdStatus,
              ...sentryStage,
            },
          });
          throw gptImageError;
        }
      }
    }
  }

  // Diagnostic log — gated on DEBUG_LOGS. In prod, ground truth comes from:
  //   - images.image_generation_call_id (null = fallback ran, non-null = gpt-image-2)
  //   - Sentry events tagged stage=gpt_image_2_fallback / nano_banana_pro_fallback
  //     / flux_fallback with full meshModel + subStage context
  // This line stays opt-in for live debugging without polluting prod logs.
  debugLog(
    `[mesh] image_gen provider=${provider} meshModel=${sentryStage.meshModel}` +
      (sentryStage.subStage ? ` subStage=${sentryStage.subStage}` : '') +
      (provider === 'gpt-image-2' ? ` quality=${openAiQuality}` : '') +
      ` selected=${selectedImageGenerationModel}` +
      ` contentType=${result.contentType}` +
      ` callId=${result.imageCallId ?? 'none'}`,
  );

  return result;
}

// Helper function to get the most recent mesh preview from the conversation
async function getRecentMeshPreview(
  supabaseClient: SupabaseClient,
  userId: string,
  conversationId: string,
): Promise<string | null> {
  try {
    // Get the most recent mesh from this conversation
    const { data: recentMesh, error: meshError } = await supabaseClient
      .from('meshes')
      .select('id')
      .eq('user_id', userId)
      .eq('conversation_id', conversationId)
      .eq('status', 'success')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (meshError || !recentMesh) {
      return null;
    }

    // Check if a preview exists for this mesh
    const { data: previewFiles, error: previewError } =
      await supabaseClient.storage
        .from('images')
        .list(`${userId}/${conversationId}`, {
          search: `preview-${recentMesh.id}`,
          limit: 1,
        });

    if (previewError || !previewFiles || previewFiles.length === 0) {
      return null;
    }

    return previewFiles[0].name;
  } catch (error) {
    console.warn('Failed to get recent mesh preview:', error);
    return null;
  }
}

// Trim to guard against copy-pasted env vars with trailing newlines,
// which make fetch() throw "Invalid header value" on any API call and
// surface to the user as "3D Object failed to generate".
fal.config({
  credentials: Deno.env.get('FAL_KEY')?.trim() ?? '',
});

// Initialize Google GenAI client
const googleGenAI = new GoogleGenAI({
  apiKey: Deno.env.get('GOOGLE_API_KEY')?.trim() ?? '',
});

// Initialize OpenAI client for gpt-image-2 via Responses API
const openAI = new OpenAI({
  apiKey: Deno.env.get('OPENAI_API_KEY') ?? '',
});

const supabaseClient = getServiceRoleSupabaseClient();

// Initialize Anthropic client for fun message generation
const anthropic = new Anthropic({
  apiKey: Deno.env.get('ANTHROPIC_API_KEY')?.trim() ?? '',
});

// Helper function to stream message data to the client
function streamMessage(
  controller: ReadableStreamDefaultController,
  message: Record<string, unknown>,
) {
  controller.enqueue(new TextEncoder().encode(JSON.stringify(message) + '\n'));
}

// System prompt for generating fun upscale messages
const upscaleSystemPrompt = `You are AzureFilm Generator, a practical assistant who creates 3D meshes. 
You're about to upscale a mesh to production quality. 
Generate a SHORT (1 sentence max), enthusiastic message about starting the upscale.
Be quirky and excited! Use wordplay or puns if appropriate.
Do NOT use quotes around your response.`;

Deno.serve(async (req) => {
  const tokenLedger = new DeferredTokenLedger(billing);
  try {
    debugLog('=== DENO.SERVE MESH FUNCTION ENTRY POINT ===');
    debugLog('Mesh function called', {
      method: req.method,
      url: req.url,
      timestamp: new Date().toISOString(),
    });

    if (req.method === 'OPTIONS') {
      console.log('=== HANDLING OPTIONS REQUEST ===');
      return new Response('ok', { headers: corsHeaders });
    }

    if (req.method !== 'POST') {
      console.log('=== METHOD NOT ALLOWED ===', req.method);
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Authenticate user using bearer token
    debugLog('=== AUTHENTICATING USER ===');
    const authHeader = req.headers.get('Authorization');
    const token = authHeader?.replace('Bearer ', '');
    debugLog('Auth header present:', !!authHeader);
    const { data: userData, error: userError } =
      await supabaseClient.auth.getUser(token);

    if (!userData.user) {
      logError(new Error('No user found in token'), {
        functionName: 'mesh',
        statusCode: 401,
      });
      return new Response(
        JSON.stringify({ error: { message: 'Unauthorized' } }),
        {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
    }

    if (userError) {
      logError(userError, {
        functionName: 'mesh',
        statusCode: 401,
      });
      return new Response(
        JSON.stringify({ error: { message: userError.message } }),
        {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
    }

    if (!userData.user.email) {
      return new Response(
        JSON.stringify({ error: { message: 'User email missing' } }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
    }

    const requestBody = await req.json();

    debugLog('=== MESH FUNCTION CALLED ===');
    debugLog('Mesh function request body:', {
      ...requestBody,
      text: requestBody.text
        ? requestBody.text.substring(0, 100) + '...'
        : undefined,
    });

    const {
      images,
      mesh,
      text,
      conversationId,
      model,
      meshTopology,
      polygonCount,
      preferredFormat,
      action,
      meshId: actionMeshId,
      parentMessageId,
      imageGenerationModel,
      multiviewImages,
      semanticMaterialMap,
    }: {
      images?: string[];
      mesh?: string;
      text?: string;
      conversationId?: string;
      model?: Model;
      meshTopology?: 'quads' | 'polys';
      polygonCount?: number;
      preferredFormat?: 'glb' | 'fbx';
      action?: 'upscale';
      meshId?: string;
      parentMessageId?: string;
      imageGenerationModel?: ImageGenerationModel;
      multiviewImages?: MultiviewImages;
      semanticMaterialMap?: SemanticMaterialMap;
    } = requestBody;

    debugLog('Model parameter extracted:', model);

    if (!conversationId) {
      logError(new Error('Conversation ID is required'), {
        functionName: 'mesh',
        statusCode: 400,
        userId: userData.user?.id,
      });
      return new Response(
        JSON.stringify({ error: { message: 'Conversation ID is required' } }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
    }

    const hasMultiviewImages =
      model === 'multiview' &&
      !!multiviewImages?.front &&
      typeof multiviewImages.front === 'string';

    if (action === 'upscale' && !actionMeshId) {
      return new Response(
        JSON.stringify({ error: { message: 'Mesh ID is required' } }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
    }

    if (
      action !== 'upscale' &&
      (!images || !Array.isArray(images) || images.length === 0) &&
      !text &&
      !mesh &&
      !hasMultiviewImages
    ) {
      logError(new Error('Images or text not found'), {
        functionName: 'mesh',
        statusCode: 400,
        userId: userData.user?.id,
        conversationId,
        additionalContext: {
          hasImages: !!images,
          imagesLength: images?.length,
          hasText: !!text,
          hasMesh: !!mesh,
          hasMultiviewImages,
        },
      });
      return new Response(
        JSON.stringify({ error: { message: 'Images or text not found' } }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
    }

    const limitViolation = await checkGenerationCostControls({
      supabaseClient,
      userId: userData.user.id,
    });
    if (limitViolation) {
      return new Response(
        JSON.stringify(costControlErrorBody(limitViolation)),
        {
          status: 429,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
    }

    const meshTokenCost =
      action === 'upscale'
        ? FEATURE_COSTS.upscaleMesh.tokens
        : getCreativeModelTokenCost(
            model === 'fast' ||
              model === 'quality' ||
              model === 'ultra' ||
              model === 'multiview'
              ? model
              : 'quality',
          );

    const meshReferenceId = crypto.randomUUID();
    try {
      const result = await tokenLedger.reserve(userData.user.email, {
        tokens: meshTokenCost,
        operation: 'mesh',
        referenceId: meshReferenceId,
        userId: userData.user.id,
      });
      if (!result.ok) {
        return new Response(
          JSON.stringify({
            error: {
              message: 'insufficient_tokens',
              code: 'insufficient_tokens',
              tokensRequired: result.tokensRequired,
              tokensAvailable: result.tokensAvailable,
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
        functionName: 'mesh',
        statusCode: status,
        userId: userData.user.id,
      });
      return new Response(
        JSON.stringify({ error: { message: 'billing_unavailable' } }),
        {
          status: 502,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
    }

    // Handle upscale action with streaming response
    if (action === 'upscale' && actionMeshId && conversationId) {
      debugLog('=== UPSCALE ACTION ===');
      debugLog('Upscaling mesh:', actionMeshId);

      // Get the original mesh data to find the seed image
      const { data: originalMesh, error: originalMeshError } =
        await supabaseClient
          .from('meshes')
          .select('*')
          .eq('id', actionMeshId)
          .single();

      if (originalMeshError || !originalMesh) {
        await tokenLedger.releaseAll(logReservationFailure);
        return new Response(
          JSON.stringify({ error: { message: 'Original mesh not found' } }),
          {
            status: 404,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          },
        );
      }

      // Get the seed image from the mesh's images column
      const seedImageId = originalMesh.images?.[0];
      if (!seedImageId) {
        await tokenLedger.releaseAll(logReservationFailure);
        return new Response(
          JSON.stringify({
            error: { message: 'No seed image found for this mesh' },
          }),
          {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          },
        );
      }

      // Download the seed image from storage
      const { data: imageBlob, error: downloadError } =
        await supabaseClient.storage
          .from('images')
          .download(`${userData.user.id}/${conversationId}/${seedImageId}`);

      if (downloadError || !imageBlob) {
        await tokenLedger.releaseAll(logReservationFailure);
        return new Response(
          JSON.stringify({
            error: { message: 'Failed to download seed image' },
          }),
          {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          },
        );
      }

      // Upload to FAL storage. Preserve the blob's actual MIME because the
      // image decoder relies on extension + MIME matching the bytes.
      const seedMime = detectImageMediaType(
        await imageBlob.arrayBuffer(),
        imageBlob.type,
      );
      const seedExt =
        seedMime === 'image/jpeg'
          ? 'jpg'
          : seedMime === 'image/webp'
            ? 'webp'
            : 'png';
      const imageFile = new File([imageBlob], `seed-image.${seedExt}`, {
        type: seedMime,
      });
      const imageUrl = await fal.storage.upload(imageFile);
      debugLog('Uploaded seed image to FAL:', imageUrl, { seedMime });

      // Create new mesh entry for upscaled result
      const { data: newMeshData, error: newMeshError } = await supabaseClient
        .from('meshes')
        .insert({
          id: meshReferenceId,
          user_id: userData.user.id,
          images: originalMesh.images,
          conversation_id: conversationId,
          file_type: 'glb',
          prompt: {
            ...((originalMesh.prompt as Record<string, unknown>) || {}),
            upscaledFrom: actionMeshId,
            model: 'ultra', // Mark as ultra since it's upscaled
          },
        })
        .select()
        .single();

      if (newMeshError || !newMeshData) {
        await tokenLedger.releaseAll(logReservationFailure);
        return new Response(
          JSON.stringify({
            error: { message: 'Failed to create upscaled mesh entry' },
          }),
          {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          },
        );
      }

      const newMessageId = crypto.randomUUID();
      const originalPrompt = (originalMesh.prompt as Record<string, unknown>)
        ?.text as string | undefined;

      // Create the streaming response
      const responseStream = new ReadableStream({
        async start(controller) {
          try {
            let content = {
              text: '',
              mesh: { id: newMeshData.id, fileType: 'glb' as const },
              model: 'ultra' as const,
            };

            const messageData = {
              id: newMessageId,
              conversation_id: conversationId,
              role: 'assistant',
              content,
              parent_message_id: parentMessageId || null,
              created_at: new Date().toISOString(),
            };

            // Send initial empty message to show loading state with ellipsis
            streamMessage(controller, messageData);

            // Stream the message generation using Claude
            const stream = await anthropic.messages.create({
              model: 'claude-haiku-4-5-20251001',
              max_tokens: 100,
              system: upscaleSystemPrompt,
              messages: [
                {
                  role: 'user',
                  content: originalPrompt
                    ? `Generate a fun message about upscaling this: "${originalPrompt}"`
                    : 'Generate a fun message about upscaling a mesh to production quality',
                },
              ],
              stream: true,
            });

            // Stream each text delta to the client
            for await (const chunk of stream) {
              if (
                chunk.type === 'content_block_delta' &&
                chunk.delta.type === 'text_delta'
              ) {
                content = {
                  ...content,
                  text: (content.text || '') + chunk.delta.text,
                };
                streamMessage(controller, {
                  ...messageData,
                  content,
                });
              }
            }

            // Insert the final message into the database
            const { error: messageError } = await supabaseClient
              .from('messages')
              .insert({
                id: newMessageId,
                conversation_id: conversationId,
                role: 'assistant',
                content,
                parent_message_id: parentMessageId || null,
              });

            if (messageError) {
              debugLog('Failed to create upscale message:', messageError);
            }

            // Update conversation's current leaf to the new message
            await supabaseClient
              .from('conversations')
              .update({ current_message_leaf_id: newMessageId })
              .eq('id', conversationId);

            // Submit to Hunyuan3D V3 for upscaling (after message is created)
            const supabaseHost =
              (Deno.env.get('ENVIRONMENT') === 'local'
                ? Deno.env.get('NGROK_URL')
                : Deno.env.get('SUPABASE_URL')
              )?.trim() ?? '';

            const hunyuanInput = {
              input_image_url: imageUrl,
              enable_pbr: false,
              face_count: 500000,
            };
            try {
              await fal.queue.submit('fal-ai/hunyuan-3d/v3.1/pro/image-to-3d', {
                input: hunyuanInput,
                webhookUrl: `${supabaseHost}/functions/v1/fal-webhook?id=${newMeshData.id}`,
              });
              await logFalMeshCost(
                supabaseClient,
                newMeshData.id,
                'fal-ai/hunyuan-3d/v3.1/pro/image-to-3d',
                { units: HUNYUAN_PRO_UPSCALE_UNITS },
              );
              debugLog(
                'Successfully submitted to Hunyuan3D v3.1 Pro for upscaling',
              );
            } catch (submitError) {
              const errObj = submitError as {
                body?: unknown;
                status?: number;
              };
              console.error('Hunyuan v3.1 Pro submit failed:', {
                message:
                  submitError instanceof Error
                    ? submitError.message
                    : String(submitError),
                status: errObj?.status,
                body: errObj?.body,
                input: hunyuanInput,
              });
              throw submitError;
            }

            // Create a preview for the upscaled mesh (non-blocking)
            createHunyuanPreview(
              imageUrl,
              'upscale preview',
              userData.user.id,
              conversationId,
              newMeshData.id,
              supabaseHost,
            ).catch((e) =>
              debugLog('Preview creation failed (non-critical):', e),
            );

            // Stream final message state
            streamMessage(controller, {
              ...messageData,
              content,
            });

            controller.close();
          } catch (error) {
            debugLog('Error in upscale stream:', error);
            await tokenLedger.releaseAll(logReservationFailure);
            await supabaseClient
              .from('meshes')
              .update({ status: 'failure' })
              .eq('id', newMeshData.id);
            controller.error(error);
          }
        },
      });

      return new Response(responseStream, {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      });
    }

    // Determine file type based on model, topology, and user preference
    let fileType: MeshFileType;
    if (model === 'quality' && meshTopology === 'quads') {
      // For quad topology, allow user to choose format (default to FBX for better quad support)
      fileType = preferredFormat || 'fbx';
    } else {
      // For non-quad topology, default to GLB
      fileType = 'glb';
    }

    const meshImageIds =
      model === 'multiview' && multiviewImages
        ? MULTIVIEW_SLOTS.map((slot) => multiviewImages[slot]).filter(
            (id): id is string => typeof id === 'string' && id.length > 0,
          )
        : (images ?? []);

    const { data: meshData, error: meshError } = await supabaseClient
      .from('meshes')
      .insert({
        id: meshReferenceId,
        user_id: userData.user.id,
        images: meshImageIds.length > 0 ? meshImageIds : null,
        conversation_id: conversationId,
        file_type: fileType,
        prompt: {
          ...(text && { text: text }),
          ...(images && images.length > 0 && { images: images }),
          ...(mesh && { mesh: mesh }),
          ...(model && { model: model }),
          ...(imageGenerationModel && { imageGenerationModel }),
          ...(multiviewImages && { multiviewImages }),
          ...(semanticMaterialMap && { semanticMaterialMap }),
        },
      })
      .select()
      .single();

    if (meshError) {
      await tokenLedger.releaseAll(logReservationFailure);
      logError(meshError, {
        functionName: 'mesh',
        statusCode: 500,
        userId: userData.user?.id,
        conversationId,
        additionalContext: {
          operation: 'insert_mesh_record',
          fileType,
          model,
        },
      });
      return new Response(
        JSON.stringify({ error: { message: meshError.message } }),
        {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
    }

    // Skip Flux-based preview for quality; it produces its own Hunyuan preview
    // from an already-prepared seed image.
    if (model !== 'quality' && model !== 'multiview') {
      EdgeRuntime.waitUntil(
        submitPreviewJob(
          supabaseClient,
          text,
          images,
          mesh,
          userData.user.id,
          conversationId,
          meshData.id,
        ),
      );
    }

    console.log('=== SUBMITTING MESH JOB ===');
    debugLog(
      'Final model parameter being passed to submitMeshJob:',
      model ?? 'quality',
    );

    EdgeRuntime.waitUntil(
      submitMeshJob(
        supabaseClient,
        text,
        images,
        mesh,
        userData.user.id,
        conversationId,
        meshData.id,
        model ?? 'quality',
        meshTopology,
        polygonCount,
        imageGenerationModel,
        multiviewImages,
        tokenLedger,
        meshReferenceId,
      ),
    );

    return new Response(JSON.stringify({ id: meshData.id, fileType }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (unexpectedError) {
    console.error('=== UNEXPECTED ERROR IN MESH FUNCTION ===');
    console.error('Unexpected error:', unexpectedError);
    console.error(
      'Error stack:',
      unexpectedError instanceof Error ? unexpectedError.stack : undefined,
    );
    await tokenLedger.releaseAll(logReservationFailure);

    return new Response(
      JSON.stringify({
        error: {
          message: 'An unexpected error occurred',
          details:
            unexpectedError instanceof Error
              ? unexpectedError.message
              : String(unexpectedError),
        },
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      },
    );
  }
});

// Function that submits a mesh job to fal
async function submitMeshJob(
  supabaseClient: SupabaseClient,
  text: string | undefined,
  images: string[] | undefined,
  mesh: string | undefined,
  userId: string,
  conversationId: string,
  meshId: string,
  model: Model,
  meshTopology: 'quads' | 'polys' | undefined,
  polygonCount: number | undefined,
  imageGenerationModel: ImageGenerationModel | undefined,
  multiviewImages: MultiviewImages | undefined,
  tokenLedger: DeferredTokenLedger,
  meshReferenceId: string,
) {
  debugLog('=== SUBMIT MESH JOB FUNCTION CALLED ===');
  debugLog('submitMeshJob received model:', model);
  // debugLog('submitMeshJob model === ultra:', model === 'ultra');

  const supabaseHost =
    (Deno.env.get('ENVIRONMENT') === 'local'
      ? Deno.env.get('NGROK_URL')
      : Deno.env.get('SUPABASE_URL')
    )?.trim() ?? '';

  debugLog('Environment variables:', {
    ENVIRONMENT: Deno.env.get('ENVIRONMENT'),
    SUPABASE_URL: Deno.env.get('SUPABASE_URL') ? 'SET' : 'NOT SET',
    NGROK_URL: Deno.env.get('NGROK_URL') ? 'SET' : 'NOT SET',
    supabaseHost: supabaseHost,
  });

  let imageInputs: string[] = [];
  const meshTextPrompt = text?.trim() || undefined;

  try {
    if (model === 'multiview') {
      debugLog('=== ENTERING MULTIVIEW MODEL PATH (HUNYUAN 3D V3.1 PRO) ===');

      if (!multiviewImages?.front) {
        throw new Error('Front view is required for multiview mesh generation');
      }

      const availableSlots = MULTIVIEW_SLOTS.filter((slot) => {
        const imageId = multiviewImages[slot];
        return typeof imageId === 'string' && imageId.length > 0;
      });

      const imageFiles = availableSlots.map((slot) => {
        const imageId = multiviewImages[slot];
        return `${userId}/${conversationId}/${imageId}`;
      });

      const { data: imageSignedUrls, error: imageSignedUrlsError } =
        await supabaseClient.storage
          .from('images')
          .createSignedUrls(imageFiles, 60 * 60);

      if (imageSignedUrlsError) {
        throw new Error(imageSignedUrlsError.message);
      }

      const signedUrlBySlot: Partial<
        Record<(typeof MULTIVIEW_SLOTS)[number], string>
      > = {};
      availableSlots.forEach((slot, index) => {
        const signedUrl = imageSignedUrls?.[index];
        if (!signedUrl?.error && signedUrl?.signedUrl) {
          signedUrlBySlot[slot] = reformatSignedUrl(signedUrl.signedUrl);
        }
      });

      if (!signedUrlBySlot.front) {
        throw new Error('No valid front image found for multiview generation');
      }

      const faceCount = polygonCount
        ? Math.max(40000, Math.min(1500000, polygonCount))
        : 500000;
      const hunyuanInput = {
        input_image_url: signedUrlBySlot.front,
        ...(signedUrlBySlot.back && {
          back_image_url: signedUrlBySlot.back,
        }),
        ...(signedUrlBySlot.left && {
          left_image_url: signedUrlBySlot.left,
        }),
        ...(signedUrlBySlot.right && {
          right_image_url: signedUrlBySlot.right,
        }),
        generate_type: 'Normal' as const,
        enable_pbr: false,
        face_count: faceCount,
      };

      debugLog('Submitting multiview mesh to Hunyuan 3D v3.1 Pro', {
        slots: availableSlots,
        faceCount,
      });

      const hunyuanSubmission = await fal.queue.submit(
        HUNYUAN_3D_PRO_IMAGE_TO_3D_ENDPOINT,
        {
          input: hunyuanInput,
          webhookUrl: `${supabaseHost}/functions/v1/fal-webhook?id=${meshId}`,
        },
      );
      await recordFalQueueRequest(
        supabaseClient,
        meshId,
        HUNYUAN_3D_PRO_IMAGE_TO_3D_ENDPOINT,
        hunyuanSubmission,
        HUNYUAN_PRO_MULTIVIEW_UNITS,
      );

      await createHunyuanPreview(
        signedUrlBySlot.front,
        'multiview front image',
        userId,
        conversationId,
        meshId,
        supabaseHost,
      );
      return;
    }

    // Collect all available images from different sources
    let meshImages: string[] = [];

    // If mesh is provided, get images of that mesh
    if (mesh) {
      // Get the mesh data to check if it has images
      const { data: meshData, error: meshDataError } = await supabaseClient
        .from('meshes')
        .select('images')
        .eq('id', mesh)
        .single();

      if (meshDataError) {
        // If we can't fetch mesh data, just continue without mesh images
        console.warn(`Failed to fetch mesh data: ${meshDataError.message}`);
      } else {
        // If the mesh has images in the images column, use those
        if (
          meshData.images &&
          Array.isArray(meshData.images) &&
          meshData.images.length > 0
        ) {
          // Use the image IDs directly since generateImageWithResponses expects IDs
          meshImages = meshData.images;
        } else {
          // Otherwise, use the preview images from storage
          // Check if preview images exist in storage
          const { data: previewImageList, error: previewListError } =
            await supabaseClient.storage
              .from('images')
              .list(`${userId}/${conversationId}`, {
                search: `preview-${mesh}`,
              });

          if (previewListError) {
            // If we can't list preview images, just continue without them
            console.warn(
              `Failed to list preview images: ${previewListError.message}`,
            );
          } else if (previewImageList && previewImageList.length > 0) {
            // Just use the preview image filenames - generateImageWithResponses will handle the fallback
            meshImages = previewImageList.map((file) => file.name);
          }
        }
      }
    }

    // Get the most recent mesh preview for visual continuity
    const recentMeshPreview = await getRecentMeshPreview(
      supabaseClient,
      userId,
      conversationId,
    );

    // Combine all available images (including recent mesh preview if available)
    const allImages = [...(images || []), ...meshImages];
    if (recentMeshPreview && !allImages.includes(recentMeshPreview)) {
      allImages.push(recentMeshPreview);
    }

    // Skip initial image generation for Max Quality - it has its own flow.
    if (model === 'ultra') {
      // Max Quality handles image generation in its dedicated branch below.
      debugLog('Skipping initial image generation for Max Quality path');
    } else if (meshTextPrompt && meshTextPrompt.trim() !== '') {
      // Generate images for standard and textureless paths.
      if (model === 'quality') {
        // Use the premium image path with fallback for quality generation.
        const { data: imageData, error: imageError } = await supabaseClient
          .from('images')
          .insert({
            user_id: userId,
            conversation_id: conversationId,
            status: 'pending',
            prompt: {
              ...(meshTextPrompt && { text: meshTextPrompt }),
              ...(allImages.length > 0 && { images: allImages }),
              ...(model && { model: model }),
              ...(imageGenerationModel && { imageGenerationModel }),
            },
          })
          .select()
          .single();

        if (imageError) {
          throw new Error(imageError.message);
        }

        await supabaseClient
          .from('meshes')
          .update({
            images: [imageData.id],
          })
          .eq('id', meshId);

        const newPrompt =
          allImages.length > 0
            ? `${instructions3D} Edit the provided image(s) to: ${meshTextPrompt}`
            : `${instructions3D} Generate a new image: ${meshTextPrompt}`;

        const { imageBytes, imageCallId, contentType } =
          await generateMeshImage(
            userId,
            conversationId,
            newPrompt,
            images ?? [],
            allImages,
            mesh,
            imageGenerationModel,
            { meshModel: 'quality' },
            imageData.id,
          );

        const { error: imageUploadError } = await supabaseClient.storage
          .from('images')
          .upload(`${userId}/${conversationId}/${imageData.id}`, imageBytes, {
            contentType,
          });

        if (imageUploadError) {
          throw new Error(imageUploadError.message);
        }

        await recordGeneratedImageAsset({
          supabaseClient,
          userId,
          conversationId,
          imageId: imageData.id,
          body: imageBytes,
          contentType,
          metadata: { source: 'mesh', model: 'quality' },
        });

        await supabaseClient
          .from('images')
          .update({
            status: 'success',
            image_generation_call_id: imageCallId,
          })
          .eq('id', imageData.id);

        const { data: imageSignedUrl, error: imageSignedUrlError } =
          await supabaseClient.storage
            .from('images')
            .createSignedUrl(
              `${userId}/${conversationId}/${imageData.id}`,
              60 * 60,
            );

        if (imageSignedUrlError) {
          throw new Error(imageSignedUrlError.message);
        }

        imageInputs = [reformatSignedUrl(imageSignedUrl.signedUrl)];
      } else {
        // Standard single-image generation for fast mode
        const { data: imageData, error: imageError } = await supabaseClient
          .from('images')
          .insert({
            user_id: userId,
            conversation_id: conversationId,
            status: 'pending',
            prompt: {
              ...(meshTextPrompt && { text: meshTextPrompt }),
              ...(allImages.length > 0 && { images: allImages }),
              ...(model && { model: model }),
              ...(imageGenerationModel && { imageGenerationModel }),
            },
          })
          .select()
          .single();

        if (imageError) {
          throw new Error(imageError.message);
        }

        await supabaseClient
          .from('meshes')
          .update({
            images: [imageData.id],
          })
          .eq('id', meshId);

        const newPrompt =
          allImages.length > 0
            ? `${instructions3D} Edit the provided image(s) to: ${meshTextPrompt}`
            : `${instructions3D} Generate a new image: ${meshTextPrompt}`;

        const { imageBytes, imageCallId, contentType } =
          await generateMeshImage(
            userId,
            conversationId,
            newPrompt,
            images ?? [],
            allImages,
            mesh,
            imageGenerationModel,
            { meshModel: 'fast' },
            imageData.id,
          );

        const { error: imageUploadError } = await supabaseClient.storage
          .from('images')
          .upload(`${userId}/${conversationId}/${imageData.id}`, imageBytes, {
            contentType,
          });

        if (imageUploadError) {
          throw new Error(imageUploadError.message);
        }

        await recordGeneratedImageAsset({
          supabaseClient,
          userId,
          conversationId,
          imageId: imageData.id,
          body: imageBytes,
          contentType,
          metadata: { source: 'mesh', model: 'fast' },
        });

        await supabaseClient
          .from('images')
          .update({
            status: 'success',
            image_generation_call_id: imageCallId,
          })
          .eq('id', imageData.id);

        const { data: imageSignedUrl, error: imageSignedUrlError } =
          await supabaseClient.storage
            .from('images')
            .createSignedUrl(
              `${userId}/${conversationId}/${imageData.id}`,
              60 * 60,
            );

        if (imageSignedUrlError) {
          throw new Error(imageSignedUrlError.message);
        }

        imageInputs = [reformatSignedUrl(imageSignedUrl.signedUrl)];
      }
    } else {
      // No text provided, use the collected images directly for mesh generation
      if (allImages.length === 0) {
        throw new Error('No images or text provided for mesh generation');
      }

      const imageFiles = allImages.map(
        (image: string) => `${userId}/${conversationId}/${image}`,
      );
      const { data: imageSignedUrls, error: imageSignedUrlsError } =
        await supabaseClient.storage
          .from('images')
          .createSignedUrls(imageFiles, 60 * 60);

      if (imageSignedUrlsError) {
        throw new Error(imageSignedUrlsError.message);
      }

      // Filter out any errors and map to just get signedURL, swap out basename for supabase host
      imageInputs = imageSignedUrls
        .filter((image) => !image.error && image.signedUrl)
        .map((image) => reformatSignedUrl(image.signedUrl));

      if (imageInputs.length === 0) {
        throw new Error('No valid images found for mesh generation');
      }
    }

    // Only validate imageInputs for models that rely on the shared image pipeline.
    // Ultra generates its own image.
    if (
      imageInputs.length === 0 &&
      model !== 'ultra' &&
      model !== 'multiview'
    ) {
      throw new Error('No valid images for 3D generation');
    }

    debugLog('=== CHECKING GENERATION PATH ===');
    debugLog('path value:', model);

    if (model === 'ultra') {
      debugLog('=== ENTERING MAX QUALITY PATH ===');

      // Check if this is first generation or conversational edit by looking for COMPLETED meshes (not images)
      // This properly handles branching - a branch won't have completed meshes
      const { data: existingCompletedMeshes, error: meshesError } =
        await supabaseClient
          .from('meshes')
          .select('id')
          .eq('conversation_id', conversationId)
          .eq('user_id', userId)
          .eq('status', 'success');

      if (meshesError) {
        throw new Error(meshesError.message);
      }

      const isFirstGeneration =
        !existingCompletedMeshes || existingCompletedMeshes.length === 0;
      const hasUploadedImages = allImages.length > 0;
      const hasText = meshTextPrompt && meshTextPrompt.trim() !== '';

      debugLog(
        `Ultra generation type: First=${isFirstGeneration}, HasImages=${hasUploadedImages}, HasText=${hasText}`,
      );

      // Validate we have something to work with
      if (!hasText && !hasUploadedImages && isFirstGeneration) {
        throw new Error('No text or images provided for ultra generation');
      }

      // Create image record
      const { data: imageData, error: imageError } = await supabaseClient
        .from('images')
        .insert({
          user_id: userId,
          conversation_id: conversationId,
          status: 'pending',
          prompt: {
            ...(meshTextPrompt && { text: meshTextPrompt }),
            ...(allImages.length > 0 && { images: allImages }),
            ...(model && { model: model }),
            ...(imageGenerationModel && { imageGenerationModel }),
          },
        })
        .select()
        .single();

      if (imageError) {
        throw new Error(imageError.message);
      }

      await supabaseClient
        .from('meshes')
        .update({
          images: [imageData.id],
        })
        .eq('id', meshId);

      // Use the shared INSTRUCTIONS_3D preamble (imported as instructions3D).

      // Build the prompt based on conversation stage.
      let ultraPrompt: string;
      let ultraSubStage: string;
      if (isFirstGeneration && !hasUploadedImages && hasText) {
        ultraPrompt = `${instructions3D} Generate: ${meshTextPrompt}`;
        ultraSubStage = 'first_gen_text_only';
      } else if (isFirstGeneration && hasUploadedImages) {
        ultraPrompt = hasText
          ? `${instructions3D} Edit this image to: ${meshTextPrompt}`
          : `${instructions3D} Enhance and optimize this image for 3D model generation`;
        ultraSubStage = 'first_gen_with_upload';
      } else {
        ultraPrompt = hasUploadedImages
          ? hasText
            ? `${instructions3D} Edit the provided image(s) to: ${meshTextPrompt}`
            : `${instructions3D} Enhance and optimize the provided image(s) for 3D model generation`
          : hasText
            ? `${instructions3D} Edit/modify the previous generation: ${meshTextPrompt}`
            : `${instructions3D} Enhance and optimize the previous generation`;
        ultraSubStage = 'conversational';
      }

      const { imageBytes, imageCallId, contentType } = await generateMeshImage(
        userId,
        conversationId,
        ultraPrompt,
        images ?? [],
        allImages,
        mesh,
        imageGenerationModel,
        { meshModel: 'ultra', subStage: ultraSubStage },
        imageData.id,
      );

      // Upload the generated base image
      const { error: imageUploadError } = await supabaseClient.storage
        .from('images')
        .upload(`${userId}/${conversationId}/${imageData.id}`, imageBytes, {
          contentType,
        });

      if (imageUploadError) {
        throw new Error(imageUploadError.message);
      }

      await recordGeneratedImageAsset({
        supabaseClient,
        userId,
        conversationId,
        imageId: imageData.id,
        body: imageBytes,
        contentType,
        metadata: { source: 'mesh', model: 'ultra', subStage: ultraSubStage },
      });

      await supabaseClient
        .from('images')
        .update({
          status: 'success',
          image_generation_call_id: imageCallId,
        })
        .eq('id', imageData.id);

      // Get signed URL for the base image.
      const { data: imageSignedUrl, error: imageSignedUrlError } =
        await supabaseClient.storage
          .from('images')
          .createSignedUrl(
            `${userId}/${conversationId}/${imageData.id}`,
            60 * 60,
          );

      if (imageSignedUrlError) {
        throw new Error(imageSignedUrlError.message);
      }

      const baseImageUrl = reformatSignedUrl(imageSignedUrl.signedUrl);

      // Default Max Quality to the highest supported polygon target when the
      // UI does not send an override.
      const maxQualityTopology = meshTopology === 'quads' ? 'quad' : 'triangle';
      const safePolycount = polygonCount
        ? Math.max(100, Math.min(MAX_QUALITY_TARGET_POLYCOUNT, polygonCount))
        : MAX_QUALITY_TARGET_POLYCOUNT;

      const maxQualityInput = {
        image_url: baseImageUrl,
        model_type: 'standard' as const,
        topology: maxQualityTopology as 'quad' | 'triangle',
        target_polycount: safePolycount,
        symmetry_mode: 'auto' as const,
        should_remesh: true,
        should_texture: true,
        enable_pbr: false,
      };

      debugLog('Submitting Max Quality image-to-3D job', {
        topology: maxQualityTopology,
        polycount: safePolycount,
      });

      const maxQualitySubmission = await fal.queue.submit(
        MAX_QUALITY_IMAGE_TO_3D_ENDPOINT,
        {
          input: maxQualityInput,
          webhookUrl: `${supabaseHost}/functions/v1/fal-webhook?id=${meshId}`,
        },
      );
      await recordFalQueueRequest(
        supabaseClient,
        meshId,
        MAX_QUALITY_IMAGE_TO_3D_ENDPOINT,
        maxQualitySubmission,
      );

      debugLog('Successfully submitted Max Quality image-to-3D job');

      // Create preview using the base image
      await createHunyuanPreview(
        baseImageUrl,
        'max quality seed image',
        userId,
        conversationId,
        meshId,
        supabaseHost,
      );
    } else if (model === 'quality') {
      debugLog('=== ENTERING QUALITY PATH ===');

      if (imageInputs.length === 0) {
        throw new Error('No valid image found for quality mesh generation');
      }

      const imageUrl = imageInputs[0];

      // ========================================================================
      // Quality pipeline with captioning and segmentation.
      // Strategy:
      // 1. Pre-fetch Moondream3 long caption and genericize it
      // 2. Try simple prompt "all the 3d models in the scene" first
      // 3. If low score, fallback to genericized caption
      // 4. If still no mask, use full-image box prompt as last resort
      // ========================================================================

      // ---- Step 1: Caption image with Moondream3 (long only to save CPU) ----
      let longCaption: string | null = null;

      try {
        debugLog('Step 1: Captioning image with Moondream3 (long only)...');

        const longResult = await withTimeout(
          fal.subscribe('fal-ai/moondream3-preview/caption', {
            input: { length: 'long', image_url: imageUrl },
          }),
          QUALITY_CAPTION_TIMEOUT_MS,
          'Moondream3 caption',
        );

        const longData = longResult.data;
        if (longData && typeof longData === 'object' && 'output' in longData) {
          longCaption =
            typeof longData.output === 'string' ? longData.output : null;
        }

        debugLog('Moondream3 caption:', longCaption?.substring(0, 100) + '...');

        // Genericize the caption - replace character names with visual descriptions
        if (longCaption) {
          const genericizePrompt = `Replace ALL character names, brand names, IP names, and proper nouns with generic visual descriptions. Keep sentence structure intact.

Rules:
- Replace ANY character name (Pikachu, Sonic, Mario, Dexter, SpongeBob, etc.) with visual descriptions
- "Pikachu" -> "yellow creature with pointed ears"
- "Sonic" -> "blue spiky creature"  
- "Dexter" -> "boy with glasses" or "humanoid figure"
- "SpongeBob" -> "yellow sponge creature"
- Remove references like "from Dexter's Laboratory" or "from Pokemon"
- Keep color, pose, action, and position descriptions
- Keep ALL non-name words exactly the same

Input: ${longCaption}

Output:`;

          try {
            const genericResult = await withTimeout(
              googleGenAI.models.generateContent({
                model: 'gemini-2.5-flash-lite',
                contents: [
                  { role: 'user', parts: [{ text: genericizePrompt }] },
                ],
              }),
              QUALITY_GENERICIZE_TIMEOUT_MS,
              'Caption genericization',
            );
            const genericText =
              genericResult.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
            if (genericText) {
              longCaption = genericText;
              debugLog(
                'Genericized caption:',
                longCaption.substring(0, 100) + '...',
              );
            }
          } catch (genError) {
            debugLog('Failed to genericize, using original:', genError);
          }
        }
      } catch (error) {
        debugLog('Error getting Moondream3 caption:', error);
      }

      // ---- Step 2: Try prompts with SAM-3/image ----
      let maskUrl: string | null = null;
      const MIN_MASK_SCORE = 0.25;

      // Helper to try a prompt with SAM-3/image
      const tryPrompt = async (name: string, prompt: string) => {
        try {
          debugLog(`Trying prompt "${name}":`, prompt);
          const result = await withTimeout(
            fal.subscribe('fal-ai/sam-3/image', {
              input: {
                image_url: imageUrl,
                prompt: prompt,
                apply_mask: false,
                include_scores: true,
              },
            }),
            QUALITY_MASK_TIMEOUT_MS,
            `SAM-3/image prompt "${name}"`,
          );

          const data = result.data;
          if (!data || typeof data !== 'object') {
            return { name, score: 0, url: null };
          }

          const masks =
            'masks' in data && Array.isArray(data.masks) ? data.masks : [];
          const scores =
            'scores' in data && Array.isArray(data.scores) ? data.scores : [];

          const score = typeof scores[0] === 'number' ? scores[0] : 0;
          const firstMask = masks[0];
          const url =
            firstMask &&
            typeof firstMask === 'object' &&
            'url' in firstMask &&
            typeof firstMask.url === 'string'
              ? firstMask.url
              : null;

          debugLog(`Prompt "${name}" result:`, { score, hasMask: !!url });
          return { name, score, url };
        } catch (error) {
          debugLog(`Prompt "${name}" failed:`, error);
          return { name, score: 0, url: null };
        }
      };

      // Try "simple" first, fallback to long_caption
      debugLog('Step 2: Trying "simple" prompt first...');
      let result = await tryPrompt('simple', 'all the 3d models in the image');

      if (result.url && result.score >= MIN_MASK_SCORE) {
        maskUrl = result.url;
        debugLog('SUCCESS: Using "simple" mask, score:', result.score);
      } else if (longCaption) {
        debugLog(
          '"simple" failed or low score, trying long_caption fallback...',
        );
        result = await tryPrompt('long_caption', longCaption);

        if (result.url && result.score >= MIN_MASK_SCORE) {
          maskUrl = result.url;
          debugLog(
            'SUCCESS: Using "long_caption" fallback mask, score:',
            result.score,
          );
        }
      } else {
        debugLog(
          'WARNING: Simple prompt failed and no Moondream caption available for fallback',
        );
      }

      if (maskUrl) {
        debugLog('Selected mask URL:', maskUrl.substring(0, 50) + '...');
      } else {
        debugLog('No valid mask from prompts, will use box fallback');
      }

      // Build SAM-3D input
      interface Sam3dInput {
        image_url: string;
        mask_urls?: string[];
        box_prompts?: {
          x_min: number;
          y_min: number;
          x_max: number;
          y_max: number;
          object_id: number;
        }[];
      }
      const sam3dInput: Sam3dInput = { image_url: imageUrl };

      if (maskUrl) {
        sam3dInput.mask_urls = [maskUrl];
        debugLog('Using generated mask for quality path');
      } else {
        // Fallback: full-image box prompt (5% inset, assumes 1024x1024)
        // This guarantees segmentation when text prompts fail
        sam3dInput.box_prompts = [
          { x_min: 51, y_min: 51, x_max: 973, y_max: 973, object_id: 1 },
        ];
        debugLog('No mask found, using full-image box fallback');
      }

      debugLog('Quality path input:', JSON.stringify(sam3dInput, null, 2));

      const sam3dEndpoint = 'fal-ai/sam-3/3d-objects';
      const sam3dSubmission = await fal.queue.submit(sam3dEndpoint, {
        input: sam3dInput,
        webhookUrl: `${supabaseHost}/functions/v1/fal-webhook?id=${meshId}`,
      });
      await recordFalQueueRequest(
        supabaseClient,
        meshId,
        sam3dEndpoint,
        sam3dSubmission,
      );

      debugLog('Successfully submitted quality path');

      // Create preview
      await createHunyuanPreview(
        imageUrl,
        'quality seed image',
        userId,
        conversationId,
        meshId,
        supabaseHost,
      );
    } else {
      debugLog('=== ENTERING FAST MODEL PATH (TRIPO TEXTURELESS) ===');

      // Use the image generated in the earlier block
      if (imageInputs.length === 0) {
        throw new Error('No valid image found for textureless mesh generation');
      }

      // Submit textureless path with the generated image.
      // NOTE: H3.1 (newer model) currently returns downstream_service_error on
      // textureless requests (Tripo-side 500). Reverted to v2.5 until fixed.
      const tripoInput = {
        image_url: imageInputs[0],
        texture: 'no' as const,
        orientation: 'default' as const,
        // Cap face count for textureless generations at 50k
        ...(polygonCount !== undefined
          ? { face_limit: Math.min(polygonCount, TEXTURELESS_MAX_POLYGONS) }
          : { face_limit: TEXTURELESS_MAX_POLYGONS }),
      };
      try {
        await fal.queue.submit('tripo3d/tripo/v2.5/image-to-3d', {
          input: tripoInput,
          webhookUrl: `${supabaseHost}/functions/v1/fal-webhook?id=${meshId}`,
        });
        await logFalMeshCost(
          supabaseClient,
          meshId,
          'tripo3d/tripo/v2.5/image-to-3d',
          { costUsd: FAL_FIXED_CALL_USD['tripo3d/tripo/v2.5/image-to-3d'] },
        );
        debugLog(
          'Successfully submitted textureless path with conversational context',
        );
      } catch (submitError) {
        const errObj = submitError as { body?: unknown; status?: number };
        console.error('Textureless submit failed:', {
          message:
            submitError instanceof Error
              ? submitError.message
              : String(submitError),
          status: errObj?.status,
          body: errObj?.body,
          input: tripoInput,
        });
        throw submitError;
      }

      // Create preview using the generated image
      await createHunyuanPreview(
        imageInputs[0],
        'textureless preview',
        userId,
        conversationId,
        meshId,
        supabaseHost,
      );
    }
  } catch (error) {
    console.error('Mesh generation failed:', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      meshId,
      model,
      hasText: !!text,
      hasImages: !!(images && images.length > 0),
      hasMultiviewImages: !!multiviewImages?.front,
      imageInputsLength: imageInputs.length,
      supabaseHost,
    });

    logApiError(error, {
      functionName: 'mesh',
      apiName: 'FAL AI',
      statusCode: 500,
      userId,
      conversationId,
      requestData: { meshId, model, meshTopology, polygonCount },
    });
    await tokenLedger.releaseReference(meshReferenceId, logReservationFailure);

    // Persist the error into prompt JSONB for diagnostic visibility (no logs pipeline)
    const errorMessage =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
    const errorStack =
      error instanceof Error && error.stack ? error.stack.slice(0, 1500) : null;
    const { data: currentRow } = await supabaseClient
      .from('meshes')
      .select('prompt')
      .eq('id', meshId)
      .single();
    const mergedPrompt = {
      ...((currentRow?.prompt as Record<string, unknown>) ?? {}),
      error: errorMessage.slice(0, 1000),
      ...(errorStack ? { errorStack } : {}),
    };
    await supabaseClient
      .from('meshes')
      .update({ status: 'failure', prompt: mergedPrompt })
      .eq('id', meshId);

    const channel = supabaseClient.channel(`mesh-updates-${userId}`);
    await channel.send({
      type: 'broadcast',
      event: 'mesh-updated',
      payload: {
        kind: 'mesh',
        id: meshId,
        status: 'failure',
        conversation_id: conversationId,
      },
    });
  }
}

// Function that submits a mesh job to fal
async function submitPreviewJob(
  supabaseClient: SupabaseClient,
  text: string | undefined,
  images: string[] | undefined,
  mesh: string | undefined,
  userId: string,
  conversationId: string,
  meshId: string,
) {
  const supabaseHost =
    (Deno.env.get('ENVIRONMENT') === 'local'
      ? Deno.env.get('NGROK_URL')
      : Deno.env.get('SUPABASE_URL')
    )?.trim() ?? '';

  let imageInputs: string[] = [];
  const previewTextPrompt = text?.trim() || undefined;

  let previewId: string | null = null;

  try {
    const { data: previewData, error: previewError } = await supabaseClient
      .from('previews')
      .insert({
        user_id: userId,
        conversation_id: conversationId,
        mesh_id: meshId,
      })
      .select()
      .single();

    if (previewError) {
      throw new Error(previewError.message);
    }

    previewId = previewData.id;

    // Collect all available images from different sources
    let meshImages: string[] = [];

    // If mesh is provided, get images of that mesh
    if (mesh) {
      // Get the mesh data to check if it has images
      const { data: meshData, error: meshDataError } = await supabaseClient
        .from('meshes')
        .select('images')
        .eq('id', mesh)
        .single();

      if (meshDataError) {
        // If we can't fetch mesh data, just continue without mesh images
        console.warn(`Failed to fetch mesh data: ${meshDataError.message}`);
      } else {
        // If the mesh has images in the images column, use those
        if (
          meshData.images &&
          Array.isArray(meshData.images) &&
          meshData.images.length > 0
        ) {
          // Use the image IDs directly since generateImageWithResponses expects IDs
          meshImages = meshData.images;
        } else {
          // Otherwise, use the preview images from storage
          // Check if preview images exist in storage
          const { data: previewImageList, error: previewListError } =
            await supabaseClient.storage
              .from('images')
              .list(`${userId}/${conversationId}`, {
                search: `preview-${mesh}`,
              });

          if (previewListError) {
            // If we can't list preview images, just continue without them
            console.warn(
              `Failed to list preview images: ${previewListError.message}`,
            );
          } else if (previewImageList && previewImageList.length > 0) {
            // Just use the preview image filenames - generateImageWithResponses will handle the fallback
            meshImages = previewImageList.map((file) => file.name);
          }
        }
      }
    }

    // Combine all available images
    const allImages = [...(images || []), ...meshImages];

    // If text exists, we generate an image from 4o then use that image to generate a mesh
    if (previewTextPrompt && previewTextPrompt.trim() !== '') {
      const newPrompt =
        allImages.length > 0
          ? `Edit the provided image(s) to: ${previewTextPrompt} Style: ${instructions3D}`
          : `Generate a new image: ${previewTextPrompt} Style: ${instructions3D}`;

      const imageBytes = await generateImageWithFalFlux(
        supabaseClient,
        userId,
        conversationId,
        newPrompt,
        allImages,
      );

      const imageId = crypto.randomUUID();

      const { error: imageUploadError } = await supabaseClient.storage
        .from('images')
        .upload(`${userId}/${conversationId}/${imageId}`, imageBytes, {
          contentType: detectImageMediaType(imageBytes),
        });

      if (imageUploadError) {
        throw new Error(imageUploadError.message);
      }

      await recordGeneratedAsset({
        supabaseClient,
        userId,
        conversationId,
        kind: 'image',
        bucket: 'images',
        objectKey: `${userId}/${conversationId}/${imageId}`,
        mimeType: detectImageMediaType(imageBytes),
        sizeBytes: getBodySizeBytes(imageBytes),
        metadata: { source: 'mesh-preview-seed' },
      });

      const { data: imageSignedUrl, error: imageSignedUrlError } =
        await supabaseClient.storage
          .from('images')
          .createSignedUrl(`${userId}/${conversationId}/${imageId}`, 60 * 60);

      if (imageSignedUrlError) {
        throw new Error(imageSignedUrlError.message);
      }

      imageInputs = [reformatSignedUrl(imageSignedUrl.signedUrl)];
    } else {
      // No text provided, use the collected images directly for mesh generation
      if (allImages.length === 0) {
        throw new Error('No images or text provided for mesh generation');
      }

      const imageFiles = allImages.map(
        (image: string) => `${userId}/${conversationId}/${image}`,
      );
      const { data: imageSignedUrls, error: imageSignedUrlsError } =
        await supabaseClient.storage
          .from('images')
          .createSignedUrls(imageFiles, 60 * 60);

      if (imageSignedUrlsError) {
        throw new Error(imageSignedUrlsError.message);
      }

      // Filter out any errors and map to just get signedURL, swap out basename for supabase host
      imageInputs = imageSignedUrls
        .filter((image) => !image.error && image.signedUrl)
        .map((image) => reformatSignedUrl(image.signedUrl));

      if (imageInputs.length === 0) {
        throw new Error('No valid images found for mesh generation');
      }
    }

    if (imageInputs.length === 0) {
      throw new Error('No valid images for 3D generation');
    }

    await fal.queue.submit('fal-ai/hunyuan3d/v2/mini/turbo', {
      input: {
        input_image_url: imageInputs[0],
      },
      webhookUrl: `${supabaseHost}/functions/v1/fal-webhook?id=${previewId}&mode=preview`,
    });
    await logFalMeshCost(
      supabaseClient,
      meshId,
      'fal-ai/hunyuan3d/v2/mini/turbo',
      {
        operation: 'preview',
      },
    );
  } catch (error) {
    logApiError(error, {
      functionName: 'mesh',
      apiName: 'FAL AI Preview',
      statusCode: 500,
      userId,
      conversationId,
      requestData: { previewId, meshId },
    });
    console.error(error);
    if (previewId) {
      await supabaseClient
        .from('previews')
        .update({ status: 'failure' })
        .eq('id', previewId);
    }
  }
  // Don't need to send update to channel because it's not a mesh we care about
}

// Helper function to create GLB preview using Hunyuan3D Mini Turbo
async function createHunyuanPreview(
  imageUrl: string,
  description: string,
  userId: string,
  conversationId: string,
  meshId: string,
  supabaseHost: string,
): Promise<void> {
  try {
    const { data: previewData, error: previewError } = await supabaseClient
      .from('previews')
      .insert({
        user_id: userId,
        conversation_id: conversationId,
        mesh_id: meshId,
      })
      .select()
      .single();

    if (previewError) {
      debugLog(`Failed to create preview record: ${previewError.message}`);
      return;
    }

    if (previewData) {
      // Hunyuan3D Mini Turbo for fast preview generation
      await fal.queue.submit('fal-ai/hunyuan3d/v2/mini/turbo', {
        input: {
          input_image_url: imageUrl,
        },
        webhookUrl: `${supabaseHost}/functions/v1/fal-webhook?id=${previewData.id}&mode=preview`,
      });
      await logFalMeshCost(
        supabaseClient,
        meshId,
        'fal-ai/hunyuan3d/v2/mini/turbo',
        {
          operation: 'preview',
        },
      );
      debugLog(`Successfully submitted ${description} to Hunyuan3D Mini Turbo`);
    }
  } catch (error) {
    debugLog(
      `Error creating Hunyuan preview: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
