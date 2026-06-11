import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { Anthropic } from 'npm:@anthropic-ai/sdk';
import { MessageParam } from 'npm:@anthropic-ai/sdk/resources/messages';
import {
  Message,
  Model,
  Content,
  Prompt,
  MeshData,
  CoreMessage,
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
import {
  getSignedUrl,
  getSignedUrls,
  formatCreativeUserMessage,
} from '../_shared/messageUtils.ts';
import { FEATURE_COSTS } from '../../../shared/tokenCosts.ts';
import { logLlmUsage } from '../_shared/providerUsage.ts';
import { checkRateLimit } from '../_shared/rateLimit.ts';

const CHAT_TOKEN_COST = FEATURE_COSTS.chat.tokens;
const RATE_LIMIT_MAX_REQUESTS = Number(
  Deno.env.get('CREATIVE_CHAT_RATE_LIMIT') ?? '20',
);
const RATE_LIMIT_WINDOW_MS = 60_000;

// Initialize Sentry for error logging
initSentry();

// Debug logging gate
const DEBUG_LOGS =
  Deno.env.get('ENVIRONMENT') === 'local' ||
  Deno.env.get('DEBUG_LOGS') === 'true';
const debugLog = (...args: unknown[]) => {
  if (DEBUG_LOGS) console.log(...args);
};
const trace = (label: string, data?: unknown) => {
  console.log(
    `AZUREFILM_GENERATOR_TRACE ${label}`,
    data !== undefined ? JSON.stringify(data).slice(0, 500) : '',
  );
};

const logRefundFailure = ({ error, charge }: RefundFailure) => {
  logError(error, {
    functionName: 'creative-chat',
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

async function formatAssistantMessage(
  message: CoreMessage,
  supabaseClient: SupabaseClient,
  userId: string,
  conversationId: string,
): Promise<MessageParam[]> {
  const messages: MessageParam[] = [];

  if (message.content.text) {
    messages.push({
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: message.content.text,
        },
      ],
    });
  }

  if (message.content.error) {
    messages.push({
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'Error generating image or mesh',
        },
      ],
    });
  }

  // Add images if they exist
  if (message.content.images?.length) {
    const imageFiles = message.content.images.map(
      (imageId) => `${userId}/${conversationId}/${imageId}`,
    );

    const imageSignedUrls = await getSignedUrls(
      supabaseClient,
      'images',
      imageFiles,
    );

    // Get the prompt column from the first image in the images table
    const { data: imageData } = await supabaseClient
      .from('images')
      .select('prompt')
      .eq('id', message.content.images[0])
      .single()
      .overrideTypes<{
        prompt: Prompt;
      }>();

    if (imageSignedUrls.length > 0) {
      messages.push({
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: message.content.images[0],
            name: 'create_image',
            input: imageData?.prompt
              ? {
                  ...(imageData?.prompt.text && {
                    text: imageData.prompt.text,
                  }),
                  ...(imageData?.prompt.images && {
                    imageIds: imageData.prompt.images,
                  }),
                }
              : {
                  text: `Generate a new image`,
                },
          },
        ],
      });

      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: message.content.images[0],
            content: [
              {
                type: 'text',
                text: `Here are the image(s) with the following ID(s) respectively: ${message.content.images.join(', ')}`,
              },
              ...imageSignedUrls.map((image) => ({
                type: 'image' as const,
                source: {
                  type: 'url' as const,
                  url: image,
                },
              })),
            ],
          },
        ],
      });
    }
  }

  // Add mesh if it exists
  if (message.content.mesh) {
    // Try to add mesh preview if it exists
    const previewSignedUrl = await getSignedUrl(
      supabaseClient,
      'images',
      `${userId}/${conversationId}/preview-${message.content.mesh.id}`,
    );

    const { data: meshData } = await supabaseClient
      .from('meshes')
      .select('prompt, status')
      .eq('id', message.content.mesh.id)
      .single()
      .overrideTypes<MeshData>();

    messages.push({
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: message.content.mesh.id,
          name: 'create_mesh',
          input: meshData?.prompt
            ? {
                ...(meshData.prompt.text && { text: meshData.prompt.text }),
                ...(meshData.prompt.images && {
                  imageIds: meshData.prompt.images,
                }),
                ...(meshData.prompt.mesh && {
                  meshId: meshData.prompt.mesh,
                }),
              }
            : {
                text: `Generate a new mesh`,
              },
        },
      ],
    });

    messages.push({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: message.content.mesh.id,
          content: previewSignedUrl
            ? [
                {
                  type: 'text',
                  text: `Here is a preview of the mesh with the ID ${message.content.mesh.id}`,
                },
                {
                  type: 'image' as const,
                  source: {
                    type: 'url' as const,
                    url: previewSignedUrl,
                  },
                },
              ]
            : [
                {
                  type: 'text',
                  text:
                    meshData?.status === 'success'
                      ? `Generated mesh with the ID ${message.content.mesh.id}`
                      : meshData?.status === 'pending'
                        ? `Generating mesh with the ID ${message.content.mesh.id}. This may take a few minutes.`
                        : `Error generating mesh with the ID ${message.content.mesh.id}`,
                },
              ],
        },
      ],
    });
  }

  return messages;
}

const systemPrompt = `You are a helpful and practical assistant called "AzureFilm Generator" whose primary purpose is to create 3D meshes.
  You can use the create_mesh tool to create 3D meshes.

  Your mission is to speak things into existence. You are fun, playful, nerdy and a little bit silly.

  Should you be asked to do something that is not related to creating 3D meshes,
  you should politely decline and say that you are not able to do that.

  Should you be asked to make something more suited for parametric CAD design than mesh modelling (i.e with measurements/dimensional requirements or a specific hardware part) ALWAYS instruct the user that they should try parametric mode to get the best results.

  Additionally, because your purpose is to create 3D meshes,
  your text answers should be concise and to the point,
  never more than one or two sentences.

  You can modify the users prompt to make it better for the tool to use,
  but you should not change the users intent.

  For printable multicolor badges, emblems, signs, logos, ornaments, and 2.5D reliefs,
  preserve the user's requested print colors and ask the mesh tool for real separate/named material regions
  such as light_silver_raised_border, light_silver_raised_text, green_enamel_field,
  black_ball_panels, and yellow_accent_stripe instead of one baked texture.

  You may ask follow up questions to clarify the users intent,
  but you should not ask more than 2 follow up questions.`;

const tools: Anthropic.Messages.ToolUnion[] = [
  {
    name: 'create_mesh',
    description:
      'When given just a text prompt, creates a 3D mesh from that text prompt. When given an array of image ids, creates a 3D mesh from those images. When given both, modifies the images and creates a 3D mesh from the modified images. When given a mesh id and a text prompt, edits the mesh with the text prompt. For printable multicolor assets, request separate or named material regions instead of one baked texture.',
    input_schema: {
      type: 'object',
      properties: {
        imageIds: {
          type: 'array',
          items: { type: 'string' },
          optional: true,
        },
        text: { type: 'string', optional: true },
        meshId: { type: 'string', optional: true },
      },
    },
  },
];

function isDirectMultiviewMeshRequest(
  model: Model,
  content: Content | undefined,
): boolean {
  return (
    model === 'multiview' &&
    typeof content?.multiviewImages?.front === 'string' &&
    content.multiviewImages.front.length > 0
  );
}

// Helper function to streamline controller.enqueue calls
function streamMessage(
  controller: ReadableStreamDefaultController,
  message: Message,
) {
  controller.enqueue(new TextEncoder().encode(JSON.stringify(message) + '\n'));
}

async function generateSuggestions(
  content: Content,
  messages: Message[],
  abortSignal: AbortSignal,
  anthropic: Anthropic,
) {
  let finalSuggestions: string[] = [];
  if (content.images || content.mesh) {
    try {
      const userMessages = messages.filter((msg) => msg.role === 'user');
      const lastUserMessage = userMessages[userMessages.length - 1];
      const userPrompt = lastUserMessage?.content?.text || 'a 3d model';

      const suggestionPrompt = `The user just asked me to create: "${userPrompt}"

Give me exactly 2 creative and fun suggestions for form modifiers that the user could prompt next in making this 3d model. These should be edits or additions to the physical shape of the original object.

IMPORTANT: Each suggestion must be exactly 2 words. Do not use fewer than 2 words or more than 2 words.

Format each as <suggestion>word1 word2</suggestion>

Examples:
- If they asked for "dragon", suggest: <suggestion>Breathing fire</suggestion><suggestion>Add hat</suggestion>
- If they asked for "printable bonsai tree", suggest: <suggestion>Add stand</suggestion><suggestion>Blooming flowers</suggestion>
- If they asked for "chicken", suggest: <suggestion>Holding lightsaber</suggestion><suggestion>Eagle wings</suggestion>`;

      const suggestionResponse = await anthropic.messages.create(
        {
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 200,
          messages: [
            {
              role: 'user',
              content: suggestionPrompt,
            },
          ],
        },
        {
          signal: abortSignal,
        },
      );

      if (
        Array.isArray(suggestionResponse.content) &&
        suggestionResponse.content.length > 0
      ) {
        const suggestionText = suggestionResponse.content
          .filter((content) => content.type === 'text')
          .map((content) => content.text)
          .join('');

        finalSuggestions =
          suggestionText
            .match(/<suggestion>(.*?)<\/suggestion>/g)
            ?.map((s) => s.replace(/<\/?suggestion>/g, '').trim()) || [];
      }
    } catch (error) {
      console.error('Error generating suggestions:', error);
      finalSuggestions = [];
    }
  }
  return finalSuggestions;
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
      functionName: 'creative-chat',
      statusCode: 401,
    });
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (userError) {
    logError(userError, {
      functionName: 'creative-chat',
      statusCode: 401,
    });
    return new Response(JSON.stringify({ error: userError.message }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Deduct chat token (1) via adam-billing
  if (!userData.user.email) {
    return new Response(JSON.stringify({ error: 'User email missing' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const rate = checkRateLimit(`creative-chat:${userData.user.id}`, {
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
      functionName: 'creative-chat',
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
    model,
    newMessageId,
  }: {
    messageId: string;
    conversationId: string;
    model: Model;
    newMessageId: string;
  } = await req.json();

  trace('request_received', {
    conversationId,
    messageId,
    model,
    newMessageId,
    userId: userData.user?.id,
  });

  // Set up cancellation via realtime
  const abortController = new AbortController();
  const { signal: abortSignal } = abortController;

  // Create a unique channel for this request
  const cancelChannelName = `cancel-request-${messageId}`;

  // Subscribe to cancellation signals via realtime
  const channel = supabaseClient
    .channel(cancelChannelName)
    .on('broadcast', { event: 'cancel' }, () => {
      abortController.abort('Request cancelled by user');
    })
    .subscribe();

  // Clean up function
  const cleanup = () => {
    supabaseClient.removeChannel(channel);
  };

  // If the client disconnects, also abort
  req.signal.addEventListener('abort', () => {
    abortController.abort('Client disconnected');
    cleanup();
  });

  const { data: messages, error: messagesError } = await supabaseClient
    .from('messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .overrideTypes<Array<{ content: Content; role: 'user' | 'assistant' }>>();

  if (messagesError) {
    await tokenLedger.refundAll(logRefundFailure);
    return new Response(
      JSON.stringify({
        error:
          messagesError instanceof Error
            ? messagesError.message
            : 'Unknown error',
      }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders,
        },
      },
    );
  }

  if (!messages || messages.length === 0) {
    await tokenLedger.refundAll(logRefundFailure);
    return new Response(
      JSON.stringify({
        error: 'Messages not found',
      }),
      {
        status: 404,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders,
        },
      },
    );
  }

  let content: Content = {
    model: model,
  };

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
    return new Response(
      JSON.stringify({
        error:
          newMessageError instanceof Error
            ? newMessageError.message
            : 'Unknown error',
      }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders,
        },
      },
    );
  }

  try {
    const messageTree = new Tree<Message>(messages);

    const newMessage = messages.find((msg) => msg.id === messageId);

    if (!newMessage) {
      throw new Error('Message not found');
    }

    if (isDirectMultiviewMeshRequest(model, newMessage.content)) {
      const meshRequestBody = {
        conversationId,
        text: newMessage.content.text,
        model,
        ...(newMessage.content.imageGenerationModel && {
          imageGenerationModel: newMessage.content.imageGenerationModel,
        }),
        multiviewImages: newMessage.content.multiviewImages,
        ...(newMessage.content.semanticMaterialMap && {
          semanticMaterialMap: newMessage.content.semanticMaterialMap,
        }),
      };

      trace('direct_multiview_mesh_request', {
        conversationId,
        messageId,
        model,
        slots: Object.keys(newMessage.content.multiviewImages ?? {}),
      });

      const result = await fetch(`${supabaseHost}/functions/v1/mesh`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: req.headers.get('Authorization') ?? '',
        },
        body: JSON.stringify(meshRequestBody),
        signal: abortSignal,
      });

      const data = await result.json().catch(() => ({}));

      if (!result.ok) {
        if (result.status === 402) {
          content = { error: 'insufficient_tokens' };
        } else {
          const errorMessage =
            typeof data?.error?.message === 'string'
              ? data.error.message
              : typeof data?.error === 'string'
                ? data.error
                : `Mesh endpoint returned ${result.status}`;
          throw new Error(errorMessage);
        }
      } else if (typeof data?.id === 'string') {
        content = {
          ...content,
          text:
            newMessage.content.text?.trim() ||
            'Generating a 3D mesh from the four multiview references.',
          mesh: {
            id: data.id,
            fileType: typeof data.fileType === 'string' ? data.fileType : 'glb',
          },
        };
      } else {
        throw new Error('Mesh endpoint did not return a mesh id');
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

      if (updatedMessageError) {
        throw updatedMessageError;
      }

      return new Response(
        JSON.stringify({
          message: updatedMessageData,
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders,
          },
        },
      );
    }

    const currentMessageBranch = messageTree.getPath(newMessage.id);

    const messagesToSend = currentMessageBranch.map((message) => {
      return {
        id: message.id,
        role: message.role,
        content: message.content,
      };
    });

    const newMessages: MessageParam[] = (
      await Promise.all(
        messagesToSend.map((message: CoreMessage) => {
          return message.role === 'user'
            ? formatCreativeUserMessage(
                message,
                supabaseClient,
                userData.user.id,
                conversationId,
              )
            : formatAssistantMessage(
                message,
                supabaseClient,
                userData.user.id,
                conversationId,
              );
        }),
      )
    ).flat();

    const anthropic = new Anthropic({
      apiKey: Deno.env.get('ANTHROPIC_API_KEY') ?? '',
    });

    const cachedTools: Anthropic.Messages.ToolUnion[] = tools.map((t, i) =>
      i === tools.length - 1
        ? { ...t, cache_control: { type: 'ephemeral' as const, ttl: '1h' } }
        : t,
    );

    trace('before_anthropic_stream', {
      messagesCount: newMessages.length,
      toolsCount: cachedTools.length,
      hasKey: !!Deno.env.get('ANTHROPIC_API_KEY'),
    });
    const stream = await anthropic.messages.create(
      {
        model: 'claude-sonnet-4-6',
        system: [
          {
            type: 'text' as const,
            text: systemPrompt,
            cache_control: { type: 'ephemeral' as const, ttl: '1h' },
          },
        ],
        max_tokens: 16000,
        messages: newMessages,
        tools: cachedTools,
        stream: true,
      },
      {
        signal: abortSignal,
      },
    );

    // Create a streaming response
    const responseStream = new ReadableStream({
      async start(controller) {
        let currentToolUse: {
          name: string;
          id: string;
          input?: string;
        } | null = null;
        // Accumulate Anthropic token usage across the stream so we can record
        // the actual provider cost at message_stop.
        let usageInputTokens = 0;
        let usageOutputTokens = 0;
        let usageCacheReadTokens = 0;

        try {
          for await (const chunk of stream) {
            if (abortSignal.aborted) {
              console.log('aborting');
              throw new Error('Request cancelled by user');
            }

            if (chunk.type === 'message_start') {
              usageInputTokens = chunk.message.usage.input_tokens ?? 0;
              usageOutputTokens = chunk.message.usage.output_tokens ?? 0;
              usageCacheReadTokens =
                chunk.message.usage.cache_read_input_tokens ?? 0;
            } else if (chunk.type === 'message_delta') {
              usageOutputTokens =
                chunk.usage.output_tokens ?? usageOutputTokens;
            } else if (chunk.type === 'content_block_start') {
              if (chunk.content_block.type === 'tool_use') {
                currentToolUse = {
                  name: chunk.content_block.name,
                  id: chunk.content_block.id,
                  input: '',
                };
                content = {
                  ...content,
                  toolCalls: [
                    ...(content.toolCalls || []),
                    {
                      name: chunk.content_block.name,
                      id: chunk.content_block.id,
                      status: 'pending',
                    },
                  ],
                };

                streamMessage(controller, {
                  ...newMessageData,
                  content: content,
                });
              }
            } else if (chunk.type === 'content_block_delta') {
              if (chunk.delta.type === 'text_delta') {
                content = {
                  ...content,
                  text: (content.text || '') + chunk.delta.text,
                };
                streamMessage(controller, {
                  ...newMessageData,
                  content: content,
                });
              } else if (chunk.delta.type === 'input_json_delta') {
                if (currentToolUse) {
                  currentToolUse.input += chunk.delta.partial_json;
                }
              }
            } else if (chunk.type === 'content_block_stop') {
              if (currentToolUse) {
                if (currentToolUse.name === 'create_mesh') {
                  debugLog('=== CREATIVE-CHAT: CREATE_MESH TOOL CALLED ===');
                  debugLog('Creative-chat: create_mesh tool called', {
                    toolUseId: currentToolUse.id,
                    model,
                    conversationId,
                  });

                  let toolInput: {
                    text?: string;
                    imageIds?: string[];
                    meshId?: string;
                  } = {};
                  try {
                    toolInput = currentToolUse.input
                      ? JSON.parse(currentToolUse.input)
                      : {};
                  } catch (error) {
                    console.error('Error parsing tool input JSON:', error);
                    content = {
                      ...content,
                      toolCalls: content.toolCalls?.map((toolCall) =>
                        toolCall.id === currentToolUse?.id
                          ? { ...toolCall, status: 'error' }
                          : toolCall,
                      ),
                    };
                    streamMessage(controller, {
                      ...newMessageData,
                      content: content,
                    });
                    continue;
                  }

                  const meshTopology = newMessage?.content?.meshTopology;
                  const polygonCount = newMessage?.content?.polygonCount;
                  const imageGenerationModel =
                    newMessage?.content?.imageGenerationModel;
                  const multiviewImages = newMessage?.content?.multiviewImages;
                  const semanticMaterialMap =
                    newMessage?.content?.semanticMaterialMap;

                  const fallbackText =
                    toolInput.text ?? newMessage?.content?.text;
                  const fallbackImages =
                    toolInput.imageIds ?? newMessage?.content?.images;

                  const meshRequestBody = {
                    conversationId: conversationId,
                    text: fallbackText,
                    images: fallbackImages,
                    mesh: toolInput.meshId,
                    model: model,
                    ...(meshTopology && { meshTopology }),
                    ...(polygonCount && { polygonCount }),
                    ...(imageGenerationModel && { imageGenerationModel }),
                    ...(multiviewImages && { multiviewImages }),
                    ...(semanticMaterialMap && { semanticMaterialMap }),
                  };

                  debugLog('=== CREATIVE-CHAT: CALLING MESH ENDPOINT ===');
                  debugLog('Creative-chat: Calling mesh endpoint', {
                    url: `${supabaseHost}/functions/v1/mesh/`,
                    body: meshRequestBody,
                    modelInBody: meshRequestBody.model,
                  });

                  const result = await fetch(
                    `${supabaseHost}/functions/v1/mesh`,
                    {
                      method: 'POST',
                      headers: {
                        'Content-Type': 'application/json',
                        Authorization: req.headers.get('Authorization') ?? '',
                      },
                      body: JSON.stringify(meshRequestBody),
                      signal: abortSignal,
                    },
                  );

                  const data = await result.json();

                  debugLog('Creative-chat: Mesh endpoint response', {
                    status: result.status,
                    ok: result.ok,
                    data: data,
                  });

                  if (!result.ok) {
                    console.error('Creative-chat: Mesh endpoint failed', {
                      status: result.status,
                      error: data.error,
                      model,
                      conversationId,
                    });

                    if (result.status === 402) {
                      content = {
                        error: 'insufficient_tokens',
                      };
                    } else {
                      content = {
                        ...content,
                        toolCalls: content.toolCalls?.map((toolCall) =>
                          toolCall.id === currentToolUse?.id
                            ? { ...toolCall, status: 'error' }
                            : toolCall,
                        ),
                      };
                    }
                  } else {
                    const mesh = { id: data.id, fileType: data.fileType };
                    content = {
                      ...content,
                      toolCalls:
                        content.toolCalls?.filter(
                          (toolCall) => toolCall.id !== currentToolUse?.id,
                        ) || [],
                      mesh,
                    };
                  }
                  streamMessage(controller, {
                    ...newMessageData,
                    content: content,
                  });
                }
                currentToolUse = null;
              }
            } else if (chunk.type === 'message_stop') {
              EdgeRuntime.waitUntil(
                logLlmUsage({
                  functionName: 'creative-chat',
                  operation: 'chat',
                  provider: 'anthropic',
                  model: 'claude-sonnet-4-6',
                  userId: userData.user?.id,
                  conversationId,
                  referenceId: newMessageId,
                  inputTokens: usageInputTokens,
                  outputTokens: usageOutputTokens,
                  cachedInputTokens: usageCacheReadTokens,
                }),
              );
              // Generate suggestions and create final message
              const finalSuggestions = await generateSuggestions(
                content,
                messages,
                abortSignal,
                anthropic,
              );

              content = {
                ...content,
                suggestions: finalSuggestions,
              };
            }
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
              functionName: 'creative-chat',
              statusCode: 500,
              userId: userData.user?.id,
              conversationId,
              additionalContext: { messageId, model, content },
            });
          }
          // Persist partial content if it has been modified beyond the default empty state
          const hasNonDefaultContent =
            !!content &&
            ((content.text && content.text.length > 0) ||
              (content.images && content.images.length > 0) ||
              !!content.mesh);

          if (!hasNonDefaultContent) {
            await tokenLedger.refundAll(logRefundFailure);
          }

          if (!hasNonDefaultContent) {
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
          const { data: finalMessageData } = await supabaseClient
            .from('messages')
            .update({ content })
            .eq('id', newMessageData.id)
            .select()
            .single()
            .overrideTypes<{
              content: Content;
              role: 'assistant';
            }>();

          if (finalMessageData) {
            streamMessage(controller, finalMessageData);
          }

          controller.close();
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
    // Handle abort errors specifically
    if (abortSignal.aborted) {
      // Persist partial content if it has been modified beyond the default empty state
      const hasNonDefaultContent =
        !!content &&
        ((content.text && content.text.length > 0) ||
          (content.images && content.images.length > 0) ||
          !!content.mesh);

      if (!hasNonDefaultContent) {
        content = {
          ...content,
          text: 'Generation stopped! Retry or enter a new prompt.',
        };
      }
    }
    const hasNonDefaultContent =
      !!content &&
      ((content.text && content.text.length > 0) ||
        (content.images && content.images.length > 0) ||
        !!content.mesh);

    if (!hasNonDefaultContent) {
      await tokenLedger.refundAll(logRefundFailure);
    }

    if (!hasNonDefaultContent) {
      content = {
        ...content,
        text: 'An error occurred while processing your request.',
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

    if (!updatedMessageError) {
      return new Response(
        JSON.stringify({
          message: updatedMessageData,
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders,
          },
        },
      );
    }

    logError(error, {
      functionName: 'creative-chat',
      statusCode: 500,
      userId: userData.user?.id,
      conversationId,
      additionalContext: { messageId, model },
    });

    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : 'Unknown error',
      }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders,
        },
      },
    );
  } finally {
    cleanup();
  }
});
