import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { getAnonSupabaseClient } from '../_shared/supabaseClient.ts';
import { billing, BillingClientError } from '../_shared/billingClient.ts';
import { initSentry, logError } from '../_shared/sentry.ts';
import { Content, Model } from '@shared/types.ts';
import {
  FEATURE_COSTS,
  getParametricModelTokenCost,
} from '../../../shared/tokenCosts.ts';

initSentry();

const TEXT_TO_CAD_WORKER_URL = Deno.env.get('TEXT_TO_CAD_WORKER_URL')?.trim();
const TEXT_TO_CAD_WORKER_TOKEN = Deno.env
  .get('TEXT_TO_CAD_WORKER_TOKEN')
  ?.trim();

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function workerConfigured(): boolean {
  return Boolean(TEXT_TO_CAD_WORKER_URL && TEXT_TO_CAD_WORKER_TOKEN);
}

function consumeTokens(
  email: string,
  userId: string,
  model: string,
  referenceId: string,
) {
  return billing.consume(email, {
    tokens: FEATURE_COSTS.chat.tokens + getParametricModelTokenCost(model),
    operation: 'parametric',
    referenceId,
    userId,
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  const supabaseClient = getAnonSupabaseClient({
    global: {
      headers: { Authorization: req.headers.get('Authorization') ?? '' },
    },
  });

  const { data: userData, error: userError } =
    await supabaseClient.auth.getUser();

  if (!userData.user) {
    logError(new Error('No user found in token'), {
      functionName: 'cad-chat',
      statusCode: 401,
    });
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  if (userError) {
    logError(userError, {
      functionName: 'cad-chat',
      statusCode: 401,
      userId: userData.user.id,
    });
    return jsonResponse({ error: userError.message }, 401);
  }

  if (!userData.user.email) {
    return jsonResponse({ error: 'User email missing' }, 400);
  }

  const {
    messageId,
    conversationId,
    model,
    newMessageId,
  }: {
    messageId: string;
    conversationId: string;
    model: Model;
    newMessageId: string;
  } = await req.json();

  const { data: userMessage, error: userMessageError } = await supabaseClient
    .from('messages')
    .select('*')
    .eq('id', messageId)
    .eq('conversation_id', conversationId)
    .single()
    .overrideTypes<{ content: Content; role: 'user' }>();

  if (userMessageError || !userMessage) {
    return jsonResponse({ error: 'Message not found' }, 404);
  }

  const jobId = crypto.randomUUID();
  const prompt = {
    text: userMessage.content.text ?? '',
    images: userMessage.content.images ?? [],
    mesh: userMessage.content.mesh?.id ?? null,
    backend: 'text-to-cad',
    source: 'earthtojake/text-to-cad',
    model,
  };

  const pendingContent: Content = {
    model,
    cadBackend: 'text-to-cad',
    text: workerConfigured()
      ? "I'll generate a STEP-first CAD model for that."
      : 'STEP-first CAD is optional and the worker is not configured for this deployment.',
    toolCalls: workerConfigured()
      ? [
          {
            name: 'create_cad_job',
            id: jobId,
            status: 'pending',
            result: { id: jobId },
          },
        ]
      : [
          {
            name: 'create_cad_job',
            id: jobId,
            status: 'error',
            result: { id: jobId },
          },
        ],
    cadJob: {
      id: jobId,
      status: workerConfigured() ? 'pending' : 'failure',
      backend: 'text-to-cad',
      ...(!workerConfigured() && {
        error: 'TEXT_TO_CAD_WORKER_URL is not configured.',
      }),
    },
  };

  const { data: assistantMessage, error: assistantMessageError } =
    await supabaseClient
      .from('messages')
      .insert({
        id: newMessageId,
        conversation_id: conversationId,
        role: 'assistant',
        content: pendingContent,
        parent_message_id: messageId,
      })
      .select()
      .single()
      .overrideTypes<{ content: Content; role: 'assistant' }>();

  if (!assistantMessage) {
    return jsonResponse(
      {
        error:
          assistantMessageError instanceof Error
            ? assistantMessageError.message
            : 'Failed to create assistant message',
      },
      500,
    );
  }

  if (!workerConfigured()) {
    return jsonResponse({ message: assistantMessage });
  }

  const { error: cadJobError } = await supabaseClient.from('cad_jobs').insert({
    id: jobId,
    user_id: userData.user.id,
    conversation_id: conversationId,
    message_id: assistantMessage.id,
    status: 'pending',
    prompt,
    error: null,
  });

  if (cadJobError) {
    logError(cadJobError, {
      functionName: 'cad-chat',
      statusCode: 500,
      userId: userData.user.id,
      conversationId,
    });
    return jsonResponse({ error: cadJobError.message }, 500);
  }

  try {
    const tokenResult = await consumeTokens(
      userData.user.email,
      userData.user.id,
      model,
      jobId,
    );
    if (!tokenResult.ok) {
      const failureContent: Content = {
        ...pendingContent,
        error: 'insufficient_tokens',
        toolCalls: pendingContent.toolCalls?.map((toolCall) => ({
          ...toolCall,
          status: 'error',
        })),
        cadJob: {
          id: jobId,
          status: 'failure',
          backend: 'text-to-cad',
          error: 'insufficient_tokens',
        },
      };
      const { data: updatedMessage } = await supabaseClient
        .from('messages')
        .update({ content: failureContent })
        .eq('id', assistantMessage.id)
        .select()
        .single()
        .overrideTypes<{ content: Content; role: 'assistant' }>();
      await supabaseClient
        .from('cad_jobs')
        .update({ status: 'failure', error: 'insufficient_tokens' })
        .eq('id', jobId);
      return jsonResponse({ message: updatedMessage ?? assistantMessage });
    }
  } catch (err) {
    const status = err instanceof BillingClientError ? err.status : 502;
    logError(err, {
      functionName: 'cad-chat',
      statusCode: status,
      userId: userData.user.id,
      conversationId,
    });
    return jsonResponse({ error: 'billing_unavailable' }, 502);
  }

  try {
    const workerResponse = await fetch(TEXT_TO_CAD_WORKER_URL!, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEXT_TO_CAD_WORKER_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jobId,
        userId: userData.user.id,
        conversationId,
        messageId: assistantMessage.id,
        prompt,
        artifactPrefix: `${userData.user.id}/${conversationId}/${jobId}`,
        callbackUrl: `${Deno.env.get('SUPABASE_URL')?.replace(/\/$/, '')}/functions/v1/cad-worker-callback`,
      }),
    });

    const workerBody = await workerResponse
      .json()
      .catch(() => ({}) as Record<string, unknown>);

    if (!workerResponse.ok) {
      throw new Error(
        typeof workerBody.error === 'string'
          ? workerBody.error
          : `Worker returned ${workerResponse.status}`,
      );
    }

    const workerRequestId =
      typeof workerBody.requestId === 'string' ? workerBody.requestId : null;
    if (workerRequestId) {
      await supabaseClient
        .from('cad_jobs')
        .update({ worker_request_id: workerRequestId })
        .eq('id', jobId);
    }
  } catch (err) {
    try {
      await billing.refund(userData.user.email, {
        tokens: getParametricModelTokenCost(model) + FEATURE_COSTS.chat.tokens,
        operation: 'parametric',
        referenceId: jobId,
        userId: userData.user.id,
      });
    } catch (refundError) {
      logError(refundError, {
        functionName: 'cad-chat',
        statusCode: 502,
        userId: userData.user.id,
        conversationId,
        additionalContext: { stage: 'refund_after_worker_submit_failure' },
      });
    }

    const error = err instanceof Error ? err.message : String(err);
    const failureContent: Content = {
      ...pendingContent,
      text: 'STEP-first CAD failed to start.',
      toolCalls: pendingContent.toolCalls?.map((toolCall) => ({
        ...toolCall,
        status: 'error',
      })),
      cadJob: {
        id: jobId,
        status: 'failure',
        backend: 'text-to-cad',
        error,
      },
    };
    const { data: updatedMessage } = await supabaseClient
      .from('messages')
      .update({ content: failureContent })
      .eq('id', assistantMessage.id)
      .select()
      .single()
      .overrideTypes<{ content: Content; role: 'assistant' }>();
    await supabaseClient
      .from('cad_jobs')
      .update({ status: 'failure', error })
      .eq('id', jobId);
    return jsonResponse({ message: updatedMessage ?? assistantMessage });
  }

  return jsonResponse({ message: assistantMessage });
});
