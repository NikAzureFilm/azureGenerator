import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { getServiceRoleSupabaseClient } from '../_shared/supabaseClient.ts';
import { initSentry, logError } from '../_shared/sentry.ts';
import { CadJobArtifact, Content } from '@shared/types.ts';

initSentry();

type CallbackBody = {
  jobId: string;
  status: 'success' | 'failure';
  artifacts?: CadJobArtifact;
  error?: string;
  title?: string;
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function isCallbackAuthorized(req: Request): boolean {
  const configuredToken = Deno.env.get('TEXT_TO_CAD_WORKER_TOKEN')?.trim();
  if (!configuredToken) return false;
  const authHeader = req.headers.get('Authorization') ?? '';
  return authHeader === `Bearer ${configuredToken}`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  if (!isCallbackAuthorized(req)) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const body = (await req.json()) as CallbackBody;
  if (!body.jobId || !['success', 'failure'].includes(body.status)) {
    return jsonResponse({ error: 'Invalid callback payload' }, 400);
  }

  const supabaseClient = getServiceRoleSupabaseClient();

  const { data: job, error: jobError } = await supabaseClient
    .from('cad_jobs')
    .select('*')
    .eq('id', body.jobId)
    .single();

  if (jobError || !job) {
    return jsonResponse({ error: 'CAD job not found' }, 404);
  }

  const artifacts = body.artifacts ?? {};
  const error =
    body.status === 'failure' ? body.error || 'CAD job failed' : null;

  const { error: updateJobError } = await supabaseClient
    .from('cad_jobs')
    .update({
      status: body.status,
      artifacts,
      error,
      updated_at: new Date().toISOString(),
    })
    .eq('id', body.jobId);

  if (updateJobError) {
    logError(updateJobError, {
      functionName: 'cad-worker-callback',
      statusCode: 500,
      userId: job.user_id,
      conversationId: job.conversation_id,
    });
    return jsonResponse({ error: updateJobError.message }, 500);
  }

  if (job.message_id) {
    const { data: message } = await supabaseClient
      .from('messages')
      .select('content')
      .eq('id', job.message_id)
      .maybeSingle()
      .overrideTypes<{ content: Content }>();

    const currentContent = message?.content ?? {};
    const content: Content = {
      ...currentContent,
      cadBackend: 'text-to-cad',
      text:
        body.status === 'success'
          ? `${body.title ?? 'STEP CAD model'} is ready.`
          : body.error || 'STEP CAD generation failed.',
      toolCalls:
        body.status === 'success'
          ? currentContent.toolCalls?.filter(
              (toolCall) => toolCall.name !== 'create_cad_job',
            )
          : currentContent.toolCalls?.map((toolCall) =>
              toolCall.name === 'create_cad_job'
                ? { ...toolCall, status: 'error' }
                : toolCall,
            ),
      cadJob: {
        id: body.jobId,
        status: body.status,
        backend: 'text-to-cad',
        artifacts,
        ...(error && { error }),
      },
    };

    const { error: updateMessageError } = await supabaseClient
      .from('messages')
      .update({ content })
      .eq('id', job.message_id);

    if (updateMessageError) {
      logError(updateMessageError, {
        functionName: 'cad-worker-callback',
        statusCode: 500,
        userId: job.user_id,
        conversationId: job.conversation_id,
      });
      return jsonResponse({ error: updateMessageError.message }, 500);
    }
  }

  const channel = supabaseClient.channel(`cad-job-updates-${job.user_id}`);
  await channel.send({
    type: 'broadcast',
    event: 'cad-job-updated',
    payload: {
      kind: 'cadJob',
      id: body.jobId,
      status: body.status,
      conversation_id: job.conversation_id,
    },
  });

  return jsonResponse({ ok: true });
});
