import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { getAnonSupabaseClient } from '../_shared/supabaseClient.ts';
import { billing, BillingClientError } from '../_shared/billingClient.ts';
import { initSentry, logError } from '../_shared/sentry.ts';
import { CadJobArtifact, Content, Model } from '@shared/types.ts';
import {
  FEATURE_COSTS,
  getParametricModelTokenCost,
} from '../../../shared/tokenCosts.ts';
import { getCodeGenerationModelCandidates } from '../../../shared/parametricRouting.ts';

initSentry();

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_API_KEY = Deno.env.get('OPENROUTER_API_KEY') ?? '';
const TEXT_TO_CAD_WORKER_URL = Deno.env.get('TEXT_TO_CAD_WORKER_URL')?.trim();
const TEXT_TO_CAD_WORKER_TOKEN = Deno.env
  .get('TEXT_TO_CAD_WORKER_TOKEN')
  ?.trim();
const MAX_TEXT_TO_CAD_ATTEMPTS = 2;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function workerConfigured(): boolean {
  return Boolean(TEXT_TO_CAD_WORKER_URL && TEXT_TO_CAD_WORKER_TOKEN);
}

function extractPythonSource(text: string): string {
  const fence = text.match(/```(?:python)?\s*([\s\S]*?)```/);
  const source = normalizeBuild123dSource((fence?.[1] ?? text).trim());
  if (!source.includes('def gen_step')) {
    throw new Error('Generated CAD source did not define gen_step().');
  }
  return source;
}

function normalizeBuild123dSource(source: string): string {
  return source.replace(/\bSortBy\.(X|Y|Z)\b/g, 'Axis.$1');
}

function buildCadSystemPrompt(): string {
  return `You generate build123d Python CAD source for STEP export.

Return only Python source code. No markdown.

Requirements:
- Use millimeters.
- Import from build123d.
- Define a function named gen_step().
- gen_step() must return one closed STEP-ready build123d Part, Solid, Compound, or Assembly.
- Prefer precise mechanical geometry: boxes, cylinders, holes, slots, chamfers, fillets, ribs, bosses, standoffs.
- Use named parameters near the top.
- Keep the model robust and simple enough to export.
- Make the result 3D-printable by default: watertight closed solids, no floating parts, no unsupported internal loose bodies, and no paper-thin walls.
- For functional mechanisms such as hinges, clips, pivots, and pins, prefer a print-ready kit with separate parts laid out on the build plate instead of an assembled model with trapped or floating parts.
- Use practical FDM clearances when dimensions are missing: 0.3-0.5 mm radial clearance for pins/holes and 0.4-0.6 mm axial gaps between moving knuckles or sliding parts.
- Place every separate printable body so its lowest Z is on the build plate, with enough spacing between bodies for slicers to separate or print them cleanly.
- For coordinate sorting, use sort_by(Axis.X), sort_by(Axis.Y), or sort_by(Axis.Z). Do not use SortBy.X, SortBy.Y, or SortBy.Z.
- Do not read files, write files, use network, subprocess, shell, or external services.
- Do not call export_step; the worker does that.`;
}

function buildCadUserPrompt(
  promptText: string,
  previousError?: string,
): string {
  const correction = previousError
    ? `

The previous generated source failed with this build123d error:
${previousError}

Return corrected Python source that avoids that error.`
    : '';

  return `Create STEP-first build123d CAD source for this request:

${promptText}

If dimensions are missing, make reasonable printable assumptions and encode them as named parameters.
If the request describes an assembly that cannot print as one reliable object, return a print-ready kit: separate closed solids arranged on the build plate with assembly clearances.${correction}`;
}

async function generateBuild123dSource(
  promptText: string,
  model: string,
  previousError?: string,
): Promise<string> {
  if (!OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY is not configured.');
  }

  const candidates = getCodeGenerationModelCandidates(model);
  let lastError = 'CAD source generation failed.';

  for (const candidate of candidates) {
    const response = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://azure-gen.vercel.app',
        'X-Title': 'AzureFilm Generator',
      },
      body: JSON.stringify({
        model: candidate,
        messages: [
          { role: 'system', content: buildCadSystemPrompt() },
          {
            role: 'user',
            content: buildCadUserPrompt(promptText, previousError),
          },
        ],
        temperature: 0.2,
      }),
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      lastError =
        typeof body?.error?.message === 'string'
          ? body.error.message
          : `OpenRouter returned ${response.status}`;
      continue;
    }

    const text = body?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) {
      lastError = 'OpenRouter returned an empty CAD source.';
      continue;
    }

    return extractPythonSource(text);
  }

  throw new Error(lastError);
}

async function submitTextToCadWorkerJob({
  jobId,
  userId,
  conversationId,
  messageId,
  prompt,
  source,
}: {
  jobId: string;
  userId: string;
  conversationId: string;
  messageId: string;
  prompt: Record<string, unknown>;
  source: string;
}) {
  const response = await fetch(TEXT_TO_CAD_WORKER_URL!, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TEXT_TO_CAD_WORKER_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jobId,
      userId,
      conversationId,
      messageId,
      prompt,
      source,
      artifactPrefix: `${userId}/${conversationId}/${jobId}`,
      callbackUrl: `${Deno.env.get('SUPABASE_URL')?.replace(/\/$/, '')}/functions/v1/cad-worker-callback`,
    }),
  });

  const body = await response
    .json()
    .catch(() => ({}) as Record<string, unknown>);

  if (!response.ok) {
    throw new TextToCadWorkerError(
      typeof body.detail === 'string'
        ? body.detail
        : typeof body.error === 'string'
          ? body.error
          : `Worker returned ${response.status}`,
      response.status,
    );
  }

  return body;
}

class TextToCadWorkerError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'TextToCadWorkerError';
  }
}

function asCadArtifacts(value: unknown): CadJobArtifact {
  if (!value || typeof value !== 'object') return {};
  const record = value as Record<string, unknown>;
  const artifacts: CadJobArtifact = {};
  for (const key of [
    'stepPath',
    'glbPath',
    'stlPath',
    'threeMfPath',
    'sourcePath',
  ] as const) {
    if (typeof record[key] === 'string') {
      artifacts[key] = record[key];
    }
  }
  return artifacts;
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

function refundTokens(
  email: string,
  userId: string,
  model: string,
  referenceId: string,
) {
  return billing.refund(email, {
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
    let workerBody: Record<string, unknown> | null = null;
    let previousError: string | undefined;

    for (let attempt = 1; attempt <= MAX_TEXT_TO_CAD_ATTEMPTS; attempt += 1) {
      const source = await generateBuild123dSource(
        prompt.text,
        model,
        previousError,
      );
      try {
        workerBody = await submitTextToCadWorkerJob({
          jobId,
          userId: userData.user.id,
          conversationId,
          messageId: assistantMessage.id,
          prompt,
          source,
        });
        break;
      } catch (error) {
        if (
          error instanceof TextToCadWorkerError &&
          error.status === 422 &&
          attempt < MAX_TEXT_TO_CAD_ATTEMPTS
        ) {
          previousError = error.message;
          continue;
        }
        throw error;
      }
    }

    if (!workerBody) {
      throw new Error('Worker did not return a response.');
    }

    const artifacts = asCadArtifacts(workerBody.artifacts);
    if (!artifacts.stepPath) {
      throw new Error('Worker did not return a STEP artifact URL.');
    }

    const successContent: Content = {
      ...pendingContent,
      text:
        typeof workerBody.title === 'string'
          ? `${workerBody.title} is ready.`
          : 'STEP CAD model is ready.',
      toolCalls: pendingContent.toolCalls?.filter(
        (toolCall) => toolCall.name !== 'create_cad_job',
      ),
      cadJob: {
        id: jobId,
        status: 'success',
        backend: 'text-to-cad',
        artifacts,
      },
    };

    const { data: updatedMessage } = await supabaseClient
      .from('messages')
      .update({ content: successContent })
      .eq('id', assistantMessage.id)
      .select()
      .single()
      .overrideTypes<{ content: Content; role: 'assistant' }>();

    return jsonResponse({ message: updatedMessage ?? assistantMessage });
  } catch (err) {
    try {
      await refundTokens(userData.user.email, userData.user.id, model, jobId);
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
    return jsonResponse({ message: updatedMessage ?? assistantMessage });
  }
});
