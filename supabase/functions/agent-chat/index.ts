import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { corsHeaders } from '../_shared/cors.ts';
import {
  Message,
  Content,
  CoreMessage,
  normalizeAgentPipeline,
} from '@shared/types.ts';
import {
  getAnonSupabaseClient,
  SupabaseClient,
} from '../_shared/supabaseClient.ts';
import Tree from '@shared/Tree.ts';
import { initSentry, logError } from '../_shared/sentry.ts';
import { billing, BillingClientError } from '../_shared/billingClient.ts';
import {
  RefundableTokenLedger,
  type RefundFailure,
} from '../_shared/refundableTokenLedger.ts';
import { getBase64Images } from '../_shared/messageUtils.ts';
import { FEATURE_COSTS } from '../../../shared/tokenCosts.ts';
import {
  getImageGenerationProvider,
  normalizeImageGenerationModel,
} from '../../../shared/imageGeneration.ts';
import { logLlmUsage } from '../_shared/providerUsage.ts';
import { checkRateLimit } from '../_shared/rateLimit.ts';

// Design-agent chat model: GPT-5.6 Terra via OpenRouter at medium reasoning
// effort — balanced capability/cost for the conversational ideation loop.
const AGENT_MODEL = 'openai/gpt-5.6-terra';
const AGENT_REASONING_EFFORT = 'medium';
const AGENT_MAX_TOKENS = 16000;

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_API_KEY = Deno.env.get('OPENROUTER_API_KEY') ?? '';

const CHAT_TOKEN_COST = FEATURE_COSTS.chat.tokens;
const RATE_LIMIT_MAX_REQUESTS = Number(
  Deno.env.get('AGENT_CHAT_RATE_LIMIT') ?? '20',
);
const RATE_LIMIT_WINDOW_MS = 60_000;

initSentry();

const trace = (label: string, data?: unknown) => {
  console.log(
    `AZUREFILM_GENERATOR_TRACE ${label}`,
    data !== undefined ? JSON.stringify(data).slice(0, 500) : '',
  );
};

const logRefundFailure = ({ error, charge }: RefundFailure) => {
  logError(error, {
    functionName: 'agent-chat',
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

// --- OpenAI-style chat message types (OpenRouter chat/completions) ---

type AgentContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

type AgentToolCallParam = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

type AgentChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | AgentContentPart[] }
  | {
      role: 'assistant';
      content: string;
      tool_calls?: AgentToolCallParam[];
    }
  | { role: 'tool'; tool_call_id: string; content: string };

function openRouterHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${OPENROUTER_API_KEY}`,
    'HTTP-Referer': 'https://azurefilm.com',
    'X-Title': 'AzureFilm Generator',
  };
}

// User turns replay as text plus inline base64 image parts (data URLs work in
// local dev where Supabase storage isn't reachable from the provider).
async function formatAgentUserMessage(
  message: CoreMessage,
  supabaseClient: SupabaseClient,
  userId: string,
  conversationId: string,
): Promise<AgentChatMessage[]> {
  const parts: AgentContentPart[] = [];

  if (message.content.text) {
    parts.push({ type: 'text', text: message.content.text });
  }

  if (message.content.images?.length) {
    const imageFiles = message.content.images.map(
      (imageId) => `${userId}/${conversationId}/${imageId}`,
    );
    const base64Images = await getBase64Images(
      supabaseClient,
      'images',
      imageFiles,
    );

    parts.push({
      type: 'text',
      text: `Here are the image(s) with the following ID(s) respectively: ${message.content.images.join(', ')}`,
    });
    parts.push(
      ...base64Images.map((image) => ({
        type: 'image_url' as const,
        image_url: { url: image.data },
      })),
    );
  }

  if (parts.length === 0) {
    return [];
  }

  return [{ role: 'user', content: parts }];
}

// Assistant turns replay as text plus tool_call/tool-result pairs so the agent
// sees the concept images it already generated and the recommendation it made.
// Image pixels are delivered in a follow-up user message — multimodal content
// on tool-role messages is not reliably supported across providers.
async function formatAgentAssistantMessage(
  message: CoreMessage,
  supabaseClient: SupabaseClient,
  userId: string,
  conversationId: string,
): Promise<AgentChatMessage[]> {
  const messages: AgentChatMessage[] = [];

  const hasImages = !!message.content.images?.length;
  const toolCallId = hasImages ? message.content.images![0] : null;

  if (message.content.text || hasImages) {
    messages.push({
      role: 'assistant',
      content: message.content.text ?? '',
      ...(toolCallId
        ? {
            tool_calls: [
              {
                id: toolCallId,
                type: 'function' as const,
                function: {
                  name: 'generate_concept_image',
                  arguments: JSON.stringify({
                    prompt: 'Generate a concept image',
                  }),
                },
              },
            ],
          }
        : {}),
    });
  }

  if (toolCallId && message.content.images?.length) {
    messages.push({
      role: 'tool',
      tool_call_id: toolCallId,
      content: `Generated concept image(s) with the following ID(s) respectively: ${message.content.images.join(', ')}`,
    });

    const imageFiles = message.content.images.map(
      (imageId) => `${userId}/${conversationId}/${imageId}`,
    );
    const base64Images = await getBase64Images(
      supabaseClient,
      'images',
      imageFiles,
    );
    if (base64Images.length > 0) {
      messages.push({
        role: 'user',
        content: [
          {
            type: 'text',
            text: '[Automated] These are the concept image(s) your tool call generated, exactly as shown to the user:',
          },
          ...base64Images.map((image) => ({
            type: 'image_url' as const,
            image_url: { url: image.data },
          })),
        ],
      });
    }
  }

  if (message.content.error) {
    messages.push({
      role: 'assistant',
      content: 'Error generating the concept image.',
    });
  }

  if (message.content.recommendation) {
    const { pipeline, reason } = message.content.recommendation;
    messages.push({
      role: 'assistant',
      content: `[I recommended the "${pipeline}" pipeline${reason ? `: ${reason}` : ''}. The user can click Generate to proceed, or keep refining.]`,
    });
  }

  return messages;
}

const systemPrompt = `You are the AzureFilm Generator design agent. Your job is to have a short back-and-forth conversation with the user to figure out exactly what 3D object they want, visualize it with concept images, and decide which generation pipeline fits best. You do NOT generate the 3D model yourself — the user clicks a Generate button once a recommendation exists.

Workflow:
1. If the request is ambiguous, ask at most 1-2 short clarifying questions first (size, style, purpose, must-have features). If it's already clear, skip straight to an image.
2. Use generate_concept_image to show the user what you understood. Pass a detailed, self-contained visual description of a SINGLE centered object. When refining an earlier concept, pass its image id as baseImageId so the identity is preserved and only the requested changes are applied.
3. After each image, briefly ask what they'd like to change. Iterate until they're happy.
4. As soon as the design is settled (or the user says something like "looks good", "generate it", "let's go"), call recommend_pipeline with the best-suited pipeline and a generation prompt. You may also call it earlier alongside an image once you're confident — the user can keep chatting even after a recommendation.

Choosing the pipeline:
- "cad": parametric CAD engineering. Best for dimensioned, functional, or mechanical parts — brackets, enclosures, gears, mounts, adapters, anything with measurements, flat faces, holes, tolerances, or hardware fit. Produces clean editable geometry, but not organic detail.
- "mesh": AI mesh generation from a single concept image. Best for organic, sculptural, or decorative objects — figurines, characters, animals, ornaments, stylized props. Great surface detail, no exact dimensions.
- "multiview": mesh generation from four labeled views (front/back/left/right). Best when the object's sides differ meaningfully and the user cares about controlling each side — vehicles, buildings, asymmetric characters. After handoff the user completes the remaining views from your front concept image.

Keep replies short — one or two sentences outside of questions. Stay on the topic of designing 3D objects; politely decline anything else. Never promise actions you have no tool for.`;

const tools = [
  {
    type: 'function' as const,
    function: {
      name: 'generate_concept_image',
      description:
        'Generates a concept image of the object being designed and shows it to the user. Pass a detailed visual description of a single centered object. To refine a previously generated concept, pass its image id as baseImageId — the new image preserves the identity of the base and applies only the described changes.',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description:
              'Detailed, self-contained visual description of the object.',
          },
          baseImageId: {
            type: 'string',
            description:
              'Optional id of an earlier concept image to refine instead of starting fresh.',
          },
        },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'recommend_pipeline',
      description:
        'Records which generation pipeline best fits the settled design. This shows the user a Generate button — it does not start generation itself. Call it once the design intent is clear.',
      parameters: {
        type: 'object',
        properties: {
          pipeline: {
            type: 'string',
            enum: ['cad', 'mesh', 'multiview'],
          },
          reason: {
            type: 'string',
            description: 'One short sentence on why this pipeline fits.',
          },
          generationPrompt: {
            type: 'string',
            description:
              'The prompt the generation pipeline should receive: a complete, self-contained description of the final object (include dimensions for cad).',
          },
        },
        required: ['pipeline', 'generationPrompt'],
      },
    },
  },
];

function streamMessage(
  controller: ReadableStreamDefaultController,
  message: Message,
) {
  try {
    controller.enqueue(
      new TextEncoder().encode(JSON.stringify(message) + '\n'),
    );
  } catch (error) {
    console.warn('Unable to stream agent-chat message to client:', error);
  }
}

function closeStream(controller: ReadableStreamDefaultController) {
  try {
    controller.close();
  } catch (error) {
    console.warn('Unable to close agent-chat stream:', error);
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', {
      status: 405,
      headers: corsHeaders,
    });
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
      functionName: 'agent-chat',
      statusCode: 401,
    });
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (userError) {
    logError(userError, {
      functionName: 'agent-chat',
      statusCode: 401,
    });
    return new Response(JSON.stringify({ error: userError.message }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (!userData.user.email) {
    return new Response(JSON.stringify({ error: 'User email missing' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const rate = checkRateLimit(`agent-chat:${userData.user.id}`, {
    limit: RATE_LIMIT_MAX_REQUESTS,
    windowMs: RATE_LIMIT_WINDOW_MS,
  });
  if (!rate.allowed) {
    return new Response(
      JSON.stringify({
        error: 'rate_limited',
        retryAfterSeconds: rate.retryAfterSeconds,
      }),
      {
        status: 429,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      },
    );
  }

  const tokenLedger = new RefundableTokenLedger(billing);
  try {
    const result = await tokenLedger.consume(userData.user.email, {
      tokens: CHAT_TOKEN_COST,
      operation: 'chat',
      referenceId: crypto.randomUUID(),
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
      functionName: 'agent-chat',
      statusCode: status,
      userId: userData.user.id,
    });
    return new Response(JSON.stringify({ error: 'billing_unavailable' }), {
      status: 502,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabaseHost =
    (Deno.env.get('ENVIRONMENT') === 'local'
      ? Deno.env.get('NGROK_URL')
      : Deno.env.get('SUPABASE_URL')
    )?.trim() ?? '';

  const {
    messageId,
    conversationId,
    newMessageId,
  }: {
    messageId: string;
    conversationId: string;
    newMessageId: string;
  } = await req.json();

  trace('request_received', {
    conversationId,
    messageId,
    newMessageId,
    userId: userData.user?.id,
  });

  // Set up cancellation via realtime (same channel scheme the client's
  // useRequestCancellation hook broadcasts on).
  const abortController = new AbortController();
  const { signal: abortSignal } = abortController;

  const cancelChannelName = `cancel-request-${messageId}`;
  const channel = supabaseClient
    .channel(cancelChannelName)
    .on('broadcast', { event: 'cancel' }, () => {
      abortController.abort('Request cancelled by user');
    })
    .subscribe();

  const cleanup = () => {
    supabaseClient.removeChannel(channel);
  };

  // Browser navigation and hard refresh should not cancel the generation.
  req.signal.addEventListener('abort', () => {
    trace('client_disconnected_generation_continues', {
      conversationId,
      messageId,
    });
  });

  const { data: messages, error: messagesError } = await supabaseClient
    .from('messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .overrideTypes<Array<{ content: Content; role: 'user' | 'assistant' }>>();

  if (messagesError || !messages || messages.length === 0) {
    await tokenLedger.refundAll(logRefundFailure);
    cleanup();
    return new Response(
      JSON.stringify({
        error:
          messagesError instanceof Error
            ? messagesError.message
            : 'Messages not found',
      }),
      {
        status: messagesError ? 500 : 404,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      },
    );
  }

  // Concept images use the image model the conversation was configured with
  // (defaults to nano-banana-2).
  const { data: conversationRow } = await supabaseClient
    .from('conversations')
    .select('settings')
    .eq('id', conversationId)
    .single();
  const conversationSettings =
    conversationRow?.settings && typeof conversationRow.settings === 'object'
      ? (conversationRow.settings as Record<string, unknown>)
      : {};
  const imageGenerationModel = normalizeImageGenerationModel(
    conversationSettings.imageGenerationModel,
  );

  let content: Content = {};

  const { data: newMessageData, error: newMessageError } = await supabaseClient
    .from('messages')
    .insert({
      id: newMessageId,
      conversation_id: conversationId,
      role: 'assistant',
      content: content,
      parent_message_id: messageId,
    })
    .select()
    .single()
    .overrideTypes<{
      content: Content;
      role: 'assistant';
    }>();

  if (!newMessageData) {
    await tokenLedger.refundAll(logRefundFailure);
    cleanup();
    return new Response(
      JSON.stringify({
        error:
          newMessageError instanceof Error
            ? newMessageError.message
            : 'Unknown error',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      },
    );
  }

  const persistContent = async (nextContent: Content) => {
    const { data, error } = await supabaseClient
      .from('messages')
      .update({ content: nextContent })
      .eq('id', newMessageData.id)
      .select()
      .single()
      .overrideTypes<{
        content: Content;
        role: 'assistant';
      }>();

    if (error) {
      console.error('Failed to persist agent-chat content:', error);
    }

    return data;
  };

  try {
    const messageTree = new Tree<Message>(messages);

    const newMessage = messages.find((msg) => msg.id === messageId);

    if (!newMessage) {
      throw new Error('Message not found');
    }

    const currentMessageBranch = messageTree.getPath(newMessage.id);

    const messagesToSend = currentMessageBranch.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
    }));

    const historyMessages: AgentChatMessage[] = (
      await Promise.all(
        messagesToSend.map((message: CoreMessage) => {
          return message.role === 'user'
            ? formatAgentUserMessage(
                message,
                supabaseClient,
                userData.user.id,
                conversationId,
              )
            : formatAgentAssistantMessage(
                message,
                supabaseClient,
                userData.user.id,
                conversationId,
              );
        }),
      )
    ).flat();

    const requestBody = {
      model: AGENT_MODEL,
      messages: [
        { role: 'system' as const, content: systemPrompt },
        ...historyMessages,
      ],
      tools,
      stream: true,
      usage: { include: true },
      max_tokens: AGENT_MAX_TOKENS,
      reasoning: { effort: AGENT_REASONING_EFFORT },
    };

    trace('before_openrouter_stream', {
      model: AGENT_MODEL,
      messagesCount: requestBody.messages.length,
      hasKey: !!OPENROUTER_API_KEY,
    });

    const response = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: openRouterHeaders(),
      body: JSON.stringify(requestBody),
      signal: abortSignal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(
        `OpenRouter API Error: ${response.status} - ${errorText.slice(0, 500)}`,
      );
      throw new Error(
        `OpenRouter API error: ${response.statusText} (${response.status})`,
      );
    }

    // Executes a fully-accumulated tool call, mutating `content`.
    const handleToolCall = async (
      controller: ReadableStreamDefaultController,
      toolCall: { id: string; name: string; arguments: string },
    ) => {
      let toolInput: {
        prompt?: string;
        baseImageId?: string;
        pipeline?: string;
        reason?: string;
        generationPrompt?: string;
      } = {};
      let toolInputValid = true;
      try {
        toolInput = toolCall.arguments ? JSON.parse(toolCall.arguments) : {};
      } catch (error) {
        console.error('Error parsing tool input JSON:', error);
        toolInputValid = false;
      }

      const markToolError = () => {
        content = {
          ...content,
          toolCalls: content.toolCalls?.map((call) =>
            call.id === toolCall.id ? { ...call, status: 'error' } : call,
          ),
        };
      };

      if (!toolInputValid) {
        markToolError();
      } else if (toolCall.name === 'generate_concept_image') {
        const result = await fetch(
          `${supabaseHost}/functions/v1/generate-view`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: req.headers.get('Authorization') ?? '',
            },
            body: JSON.stringify({
              conversationId,
              view: 'front',
              prompt: toolInput.prompt ?? '',
              provider: getImageGenerationProvider(imageGenerationModel),
              imageGenerationModel,
              mode: 'input',
              ...(toolInput.baseImageId
                ? { refImageId: toolInput.baseImageId }
                : {}),
            }),
            signal: abortSignal,
          },
        );

        const data = await result.json().catch(() => ({}));

        if (!result.ok) {
          console.error('Agent-chat: generate-view failed', {
            status: result.status,
            error: data?.error,
            conversationId,
          });

          if (result.status === 402) {
            content = { error: 'insufficient_tokens' };
          } else {
            markToolError();
          }
        } else if (typeof data?.id === 'string') {
          content = {
            ...content,
            toolCalls:
              content.toolCalls?.filter((call) => call.id !== toolCall.id) ||
              [],
            images: [...(content.images ?? []), data.id],
          };
        } else {
          markToolError();
        }
      } else if (toolCall.name === 'recommend_pipeline') {
        const pipeline = normalizeAgentPipeline(toolInput.pipeline);
        if (pipeline) {
          content = {
            ...content,
            toolCalls:
              content.toolCalls?.filter((call) => call.id !== toolCall.id) ||
              [],
            recommendation: {
              pipeline,
              ...(toolInput.reason ? { reason: toolInput.reason } : {}),
              ...(toolInput.generationPrompt
                ? { generationPrompt: toolInput.generationPrompt }
                : {}),
            },
          };
        } else {
          markToolError();
        }
      } else {
        markToolError();
      }

      streamMessage(controller, { ...newMessageData, content });
      await persistContent(content);
    };

    const responseStream = new ReadableStream({
      async start(controller) {
        // Tool calls accumulate across deltas keyed by choice index; they are
        // executed after the model's turn finishes streaming so pending
        // statuses stay visible while images generate.
        const pendingToolCalls = new Map<
          number,
          { id: string; name: string; arguments: string }
        >();
        let lastToolCallIndex = 0;
        let servedModel = AGENT_MODEL;

        try {
          const reader = response.body?.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          if (!reader) {
            throw new Error('No response body');
          }

          while (true) {
            if (abortSignal.aborted) {
              throw new Error('Request cancelled by user');
            }

            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              const data = line.slice(6);
              if (data === '[DONE]') continue;

              let chunk: {
                error?: { message?: string };
                model?: string;
                usage?: {
                  prompt_tokens?: number;
                  completion_tokens?: number;
                  cost?: number;
                };
                choices?: Array<{
                  delta?: {
                    content?: string;
                    reasoning?: string;
                    tool_calls?: Array<{
                      index?: number;
                      id?: string;
                      function?: { name?: string; arguments?: string };
                    }>;
                  };
                  finish_reason?: string;
                }>;
              };
              try {
                chunk = JSON.parse(data);
              } catch (e) {
                // Malformed chunk — log and skip, don't abort the stream.
                console.error('Error parsing SSE chunk:', e);
                continue;
              }

              if (chunk.error) {
                console.error('OpenRouter stream error:', chunk.error);
                throw new Error(
                  chunk.error.message ||
                    `OpenRouter error: ${JSON.stringify(chunk.error)}`,
                );
              }

              if (typeof chunk.model === 'string' && chunk.model) {
                servedModel = chunk.model;
              }

              if (chunk.usage) {
                EdgeRuntime.waitUntil(
                  logLlmUsage({
                    functionName: 'agent-chat',
                    operation: 'chat',
                    provider: 'openrouter',
                    model: servedModel,
                    userId: userData.user?.id,
                    conversationId,
                    referenceId: newMessageId,
                    inputTokens: chunk.usage.prompt_tokens ?? 0,
                    outputTokens: chunk.usage.completion_tokens ?? 0,
                    costUsdOverride:
                      typeof chunk.usage.cost === 'number'
                        ? chunk.usage.cost
                        : undefined,
                  }),
                );
              }

              const delta = chunk.choices?.[0]?.delta;
              if (!delta) continue;

              if (delta.content) {
                content = {
                  ...content,
                  text: (content.text || '') + delta.content,
                };
                streamMessage(controller, { ...newMessageData, content });
              }

              // delta.reasoning is consumed silently; internal reasoning
              // tokens are never surfaced in the message.

              if (delta.tool_calls) {
                for (const toolCall of delta.tool_calls) {
                  const index = toolCall.index ?? lastToolCallIndex;
                  if (toolCall.id) {
                    lastToolCallIndex = index;
                    pendingToolCalls.set(index, {
                      id: toolCall.id,
                      name: toolCall.function?.name || '',
                      arguments: toolCall.function?.arguments ?? '',
                    });
                    content = {
                      ...content,
                      toolCalls: [
                        ...(content.toolCalls || []),
                        {
                          name: toolCall.function?.name || '',
                          id: toolCall.id,
                          status: 'pending',
                        },
                      ],
                    };
                    streamMessage(controller, { ...newMessageData, content });
                    await persistContent(content);
                  } else if (toolCall.function?.arguments) {
                    const pending = pendingToolCalls.get(index);
                    if (pending) {
                      pending.arguments += toolCall.function.arguments;
                    }
                  }
                }
              }
            }
          }

          // The model's turn is fully streamed — execute the accumulated tool
          // calls in order.
          const orderedToolCalls = [...pendingToolCalls.entries()]
            .sort(([a], [b]) => a - b)
            .map(([, call]) => call);
          for (const toolCall of orderedToolCalls) {
            if (abortSignal.aborted) break;
            await handleToolCall(controller, toolCall);
          }
        } catch (error) {
          console.error(
            'AZUREFILM_GENERATOR_TRACE inner_catch',
            error instanceof Error
              ? {
                  message: error.message,
                  stack: error.stack?.slice(0, 800),
                  name: error.name,
                }
              : String(error),
          );
          if (!abortSignal.aborted) {
            logError(error, {
              functionName: 'agent-chat',
              statusCode: 500,
              userId: userData.user?.id,
              conversationId,
              additionalContext: { messageId, content },
            });
          }
          const hasNonDefaultContent =
            !!content &&
            ((content.text && content.text.length > 0) ||
              (content.images && content.images.length > 0) ||
              !!content.recommendation);

          if (!hasNonDefaultContent) {
            await tokenLedger.refundAll(logRefundFailure);
            if (abortSignal.aborted) {
              content = {
                ...content,
                text: 'Generation stopped! Retry or enter a new prompt.',
              };
            } else {
              content = {
                ...content,
                text: 'An error occurred while processing your request.',
              };
            }
          }
        } finally {
          if (content.toolCalls) {
            content = {
              ...content,
              toolCalls:
                content.toolCalls?.map((toolCall) => ({
                  ...toolCall,
                  status: 'error',
                })) || [],
            };
          }
          const finalMessageData = await persistContent(content);

          if (finalMessageData) {
            streamMessage(controller, finalMessageData);
          }

          closeStream(controller);
          cleanup();
        }
      },
    });

    return new Response(responseStream, {
      headers: {
        'Content-Type': 'text/plain',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        ...corsHeaders,
      },
    });
  } catch (error) {
    console.error(
      'AZUREFILM_GENERATOR_TRACE outer_catch',
      error instanceof Error
        ? {
            message: error.message,
            stack: error.stack?.slice(0, 800),
            name: error.name,
          }
        : String(error),
    );
    const hasNonDefaultContent =
      !!content &&
      ((content.text && content.text.length > 0) ||
        (content.images && content.images.length > 0) ||
        !!content.recommendation);

    if (!hasNonDefaultContent) {
      await tokenLedger.refundAll(logRefundFailure);
      content = {
        ...content,
        text: abortSignal.aborted
          ? 'Generation stopped! Retry or enter a new prompt.'
          : 'An error occurred while processing your request.',
      };
    }

    const { data: updatedMessageData, error: updatedMessageError } =
      await supabaseClient
        .from('messages')
        .update({ content })
        .eq('id', newMessageData.id)
        .select()
        .single()
        .overrideTypes<{
          content: Content;
          role: 'assistant';
        }>();

    cleanup();

    if (!updatedMessageError) {
      return new Response(
        JSON.stringify({
          message: updatedMessageData,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        },
      );
    }

    logError(error, {
      functionName: 'agent-chat',
      statusCode: 500,
      userId: userData.user?.id,
      conversationId,
      additionalContext: { messageId },
    });

    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : 'Unknown error',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      },
    );
  }
});
