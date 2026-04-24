import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { GoogleGenAI } from 'npm:@google/genai';
import {
  generateImageWithGeminiFlash,
  generateImageWithGeminiFlashEdit,
} from '../_shared/imageGen.ts';
import {
  getServiceRoleSupabaseClient,
  getAnonSupabaseClient,
} from '../_shared/supabaseClient.ts';
import { reformatSignedUrl } from '../_shared/messageUtils.ts';
import { detectImageMediaType } from '../_shared/imageMime.ts';
import { initSentry, logError } from '../_shared/sentry.ts';
import { Buffer } from 'node:buffer';

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

type ViewLabel = 'front' | 'left' | 'back' | 'right';

const VIEW_DIRECTIVE: Record<ViewLabel, string> = {
  front:
    'Camera directly in front of the object at eye level. The object faces the camera head-on.',
  left: 'Camera directly to the left side of the object (90° counter-clockwise from front). Show the profile of its left side.',
  back: 'Camera directly behind the object (180° from front). Show the back of the object.',
  right:
    'Camera directly to the right side of the object (90° clockwise from front). Show the profile of its right side.',
};

const BASE_INSTRUCTIONS =
  'Output a single centered object on a plain white background with neutral lighting and a soft shadow directly underneath. Keep the whole object in-frame with 5–10% padding, no cropping, no text.';

const buildPrompt = (
  view: ViewLabel,
  userPrompt: string,
  hasRef: boolean,
): string => {
  const viewDirective = VIEW_DIRECTIVE[view];
  if (hasRef) {
    return `${BASE_INSTRUCTIONS} Re-render the SAME object shown in the reference image from a different angle: ${viewDirective} Preserve the object's identity, geometry, proportions, colors, and materials exactly. Only the viewing angle changes. ${userPrompt ? `Additional guidance: ${userPrompt}` : ''}`.trim();
  }
  return `${BASE_INSTRUCTIONS} Generate a 3D-ready rendering of: ${userPrompt}. ${viewDirective}`;
};

Deno.serve(async (req) => {
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

    const { data: rawTokenResult, error: tokenError } = await serviceClient.rpc(
      'deduct_tokens',
      {
        p_user_id: userData.user.id,
        p_operation: 'chat',
      },
    );

    const tokenResult = rawTokenResult as {
      success: boolean;
      tokensRequired?: number;
      tokensAvailable?: number;
    } | null;

    if (tokenError || !tokenResult) {
      logError(tokenError ?? new Error('Token deduction returned null'), {
        functionName: 'generate-view',
        statusCode: 500,
        userId: userData.user.id,
      });
      return new Response(
        JSON.stringify({
          error: { message: tokenError?.message ?? 'Token deduction failed' },
        }),
        {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
    }

    if (!tokenResult.success) {
      return new Response(
        JSON.stringify({
          error: {
            message: 'insufficient_tokens',
            code: 'insufficient_tokens',
            tokensRequired: tokenResult.tokensRequired,
            tokensAvailable: tokenResult.tokensAvailable,
          },
        }),
        {
          status: 402,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
    }

    const {
      prompt,
      view,
      conversationId,
      refImageId,
    }: {
      prompt?: string;
      view?: ViewLabel;
      conversationId?: string;
      refImageId?: string;
    } = await req.json();

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
    if (!userPrompt && !refImageId) {
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
    const builtPrompt = buildPrompt(view, userPrompt, !!refImageId);

    debugLog('generate-view', { view, hasRef: !!refImageId });

    let imageBytes: Buffer;
    if (refImageId) {
      const refPath = `${userId}/${conversationId}/${refImageId}`;
      const { data: signedRef, error: signedRefError } =
        await serviceClient.storage
          .from('images')
          .createSignedUrl(refPath, 60 * 60);
      if (signedRefError || !signedRef?.signedUrl) {
        throw new Error(
          `Failed to sign reference image: ${signedRefError?.message ?? 'unknown'}`,
        );
      }
      imageBytes = await generateImageWithGeminiFlashEdit(
        googleGenAI,
        builtPrompt,
        reformatSignedUrl(signedRef.signedUrl),
      );
    } else {
      imageBytes = await generateImageWithGeminiFlash(googleGenAI, builtPrompt);
    }

    const imageId = crypto.randomUUID();
    const path = `${userId}/${conversationId}/${imageId}`;
    const contentType = detectImageMediaType(imageBytes);
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
