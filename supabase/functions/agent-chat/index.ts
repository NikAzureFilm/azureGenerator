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
  DeferredTokenLedger,
  type ReservationFailure,
} from '../_shared/deferredTokenLedger.ts';
import { getBase64Images } from '../_shared/messageUtils.ts';
import { FEATURE_COSTS } from '../../../shared/tokenCosts.ts';
import {
  getImageGenerationProvider,
  normalizeImageGenerationModel,
} from '../../../shared/imageGeneration.ts';
import { logLlmUsage } from '../_shared/providerUsage.ts';
import { checkRateLimit } from '../_shared/rateLimit.ts';
import { buildAgentConceptImagePrompt } from '../_shared/imagePrompt.ts';
import { buildFallbackRecommendation } from './recommendationFallback.ts';
import { KIMI_K3_MODEL } from '../../../shared/parametricRouting.ts';

// Kimi K3 powers design-agent planning as well as the selectable CAD model, so
// concept review and the downstream printable-part brief use the same model.
// Low effort keeps tool dispatch responsive; deployments can raise it through
// AGENT_CHAT_REASONING_EFFORT after latency is characterized in production.
const AGENT_MODEL = KIMI_K3_MODEL;
const AGENT_REASONING_EFFORT =
  Deno.env.get('AGENT_CHAT_REASONING_EFFORT')?.trim() || 'low';
const AGENT_MAX_TOKENS = 16000;
const KIMI_K3_MAX_ATTEMPTS = 3;
const KIMI_K3_RETRY_BASE_MS = 1_500;

// Hard ceiling per Kimi round (fetch + stream). Without it a stalled
// provider stream leaves the message empty and the client spinner infinite
// until the isolate is reaped.
const ROUND_DEADLINE_MS = 120_000;

// web_search sub-calls run on a cheap fast model with OpenRouter's
// model-agnostic web plugin (Exa) — no extra API keys needed.
const WEB_SEARCH_MODEL = 'google/gemini-3.5-flash';
const WEB_SEARCH_MAX_TOKENS = 2000;
const WEB_SEARCH_RESULT_CHAR_CAP = 6000;

// In-turn agent loop bounds. Each round is one Kimi call; the loop continues
// after web_search results AND after generate_concept_image (the render is fed
// back so the agent reviews it and may redo a flawed concept once — image cap
// still MAX_IMAGES_PER_TURN). ask_user / recommend_pipeline end the turn. A
// turn costs at most MAX_AGENT_ROUNDS model calls + MAX_WEB_SEARCHES_PER_TURN
// search sub-calls + MAX_IMAGES_PER_TURN image generations.
const MAX_AGENT_ROUNDS = 5;
const MAX_WEB_SEARCHES_PER_TURN = 3;
const MAX_IMAGES_PER_TURN = 2;

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

const logReservationFailure = ({ error, charge }: ReservationFailure) => {
  logError(error, {
    functionName: 'agent-chat',
    statusCode: 502,
    userId: charge.body.userId,
    additionalContext: {
      stage: 'release_reservation_after_generation_error',
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

class UserFacingAgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserFacingAgentError';
  }
}

type OpenRouterJsonCompletion = {
  error?: { code?: number | string; message?: string };
  choices?: Array<{
    message?: {
      content?: string;
      reasoning?: string;
      tool_calls?: unknown[];
    };
    finish_reason?: string;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
};

function completionJsonAsSse(payload: OpenRouterJsonCompletion): string {
  const chunk = {
    ...payload,
    choices: payload.choices?.map((choice) => ({
      ...choice,
      delta: choice.message,
      message: undefined,
    })),
  };
  return `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
}

async function fetchKimiK3ChatCompletion(
  requestBody: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Response> {
  const nonStreamingBody = { ...requestBody, stream: false };
  let lastResponse: Response | null = null;
  let lastText = '';

  for (let attempt = 1; attempt <= KIMI_K3_MAX_ATTEMPTS; attempt++) {
    lastResponse = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: openRouterHeaders(),
      body: JSON.stringify(nonStreamingBody),
      signal,
    });
    lastText = await lastResponse.text();

    let payload: OpenRouterJsonCompletion | null = null;
    try {
      payload = JSON.parse(lastText) as OpenRouterJsonCompletion;
    } catch {
      // Preserve the raw upstream body below.
    }

    const embeddedCode = Number(payload?.error?.code);
    const isCapacityError = lastResponse.status === 429 || embeddedCode === 429;
    if (isCapacityError && attempt < KIMI_K3_MAX_ATTEMPTS) {
      const delayMs = KIMI_K3_RETRY_BASE_MS * attempt;
      console.warn(
        `Kimi K3 provider returned 429; retrying attempt ${attempt + 1}/${KIMI_K3_MAX_ATTEMPTS} after ${delayMs}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      continue;
    }

    if (!lastResponse.ok || payload?.error || !payload) {
      const status = isCapacityError
        ? 429
        : lastResponse.ok
          ? 502
          : lastResponse.status;
      return new Response(lastText, {
        status,
        statusText: lastResponse.statusText,
        headers: lastResponse.headers,
      });
    }

    return new Response(completionJsonAsSse(payload), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }

  return new Response(lastText, {
    status: lastResponse?.status ?? 502,
    statusText: lastResponse?.statusText,
    headers: lastResponse?.headers,
  });
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

  if (message.content.question) {
    const { text, options } = message.content.question;
    messages.push({
      role: 'assistant',
      content: `[I asked the user: "${text}" — with tap-able options: ${options.join(' | ')}. Their next message is the answer (an option or a custom reply).]`,
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
1. If the request is ambiguous, clarify first — but ALWAYS via the ask_user tool, never as plain text: pass the question plus 2-4 short likely answers as options (the user can also type their own). Ask at most 1-2 questions before showing something (size, style, purpose, must-have features). If the request is already clear, skip straight to an image.
2. When the object must match real-world hardware, standards, or products (phone models, camera mounts, screw threads, brand items, dimensions you don't know), use web_search FIRST to get the facts right. Never invent dimensions of real products.
3. Use generate_concept_image to show the user what you understood. Pass a detailed, self-contained visual description of a SINGLE centered object. Every concept must read unmistakably as a polished 3D-object render. For practical CAD parts, show a slightly elevated three-quarter view on white with a neutral graphite solid material, crisp engineering geometry, visible wall thickness, and appropriate fillets, like a premium CAD product visualization, never a lifestyle photograph or flat illustration. When refining an earlier concept, pass its image id as baseImageId so the identity is preserved and only the requested changes are applied.
4. Right after each generated image, you are shown the result in this same turn. Review it critically BEFORE speaking to the user: (a) does it match what the user asked for, (b) is it ONE connected physical piece with no floating or detached elements, (c) is it free of paper-thin or unsupported features that would fail 3D printing, (d) is it a clean, dimensional 3D-object render rather than a real-world photo or flat artwork, and (e) for practical CAD, does the three-quarter view clearly communicate the engineering geometry? If it clearly fails a check, immediately call generate_concept_image again — pass baseImageId to fix small flaws while keeping the design, or start fresh when the concept itself is wrong. You get at most one automatic redo per turn; if the redo is still flawed, tell the user honestly what you would change and ask them.
5. After an image you are happy with, briefly ask what they'd like to change. Iterate until they're happy.
6. As soon as the design is settled (or the user says something like "looks good", "generate it", "let's go"), call recommend_pipeline with the best-suited pipeline and a generation prompt. You may also call it earlier alongside an image once you're confident — the user can keep chatting even after a recommendation.
7. NEVER name or recommend a pipeline only in plain text. Whenever you tell the user that CAD, Mesh, or Multiview is recommended, you MUST call recommend_pipeline in that same turn so the Generate button appears.

Everything you design MUST be 3D printable:
- One contiguous physical piece: every element attached to or touching the main body — no floating, hovering, or detached parts, no loose accessories, no assemblies of separate objects.
- Default to 0.4 mm-nozzle FDM: at least 1.2 mm walls, 0.8 mm raised details, and reinforced load-bearing tabs, bosses, and cantilevers.
- Favor a broad flat build-plate face, no unsupported islands, no bridges over about 10 mm, and no overhangs beyond 45 degrees without chamfers or self-supporting profiles.
- For mating hardware or moving parts, include 0.25-0.4 mm clearance per side, lead-in chamfers, and practical printed-hole compensation unless the user supplies calibrated values.
- Apply these constraints to every concept image description AND every generationPrompt passed to recommend_pipeline; for CAD, state the critical dimensions, orientation, wall thickness, clearance, and reinforcement explicitly.

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
        'Generates a polished three-dimensional concept render of the object being designed and shows it to the user. Pass a detailed visual description of a single centered 3D-printable object; practical CAD parts should use a three-quarter engineering-product view. To refine a previously generated concept, pass its image id as baseImageId — the new image preserves the identity of the base and applies only the described changes. The generated image is shown back to you in this same turn so you can review it and redo a flawed result.',
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
      name: 'web_search',
      description:
        'Searches the web and returns a concise, cited summary. Use it for facts you must not invent: dimensions of real products or hardware, standards (screw threads, rail profiles, hole spacings), what a named product or style actually looks like. The results come back to you in this same turn.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'A focused search query, e.g. "GoPro mount fingers dimensions mm".',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'ask_user',
      description:
        'Asks the user a clarifying question with 2-4 tap-able answer options. Always use this instead of asking questions in plain text. The user can tap an option or type a custom answer; their reply arrives as the next message. Keep options short (a few words each) and mutually exclusive.',
      parameters: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'The question to ask.',
          },
          options: {
            type: 'array',
            items: { type: 'string' },
            description: '2-4 short answer options.',
          },
        },
        required: ['question', 'options'],
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

const STREAM_HEARTBEAT_MS = 15_000;

function startStreamHeartbeat(controller: ReadableStreamDefaultController) {
  const heartbeat = new TextEncoder().encode('\n');
  return setInterval(() => {
    try {
      controller.enqueue(heartbeat);
    } catch {
      // The client disconnected or the stream already closed.
    }
  }, STREAM_HEARTBEAT_MS);
}

function sanitizeQuestionOptions(options: unknown): string[] {
  if (!Array.isArray(options)) return [];
  return options
    .filter((option): option is string => typeof option === 'string')
    .map((option) => option.trim().slice(0, 80))
    .filter(Boolean)
    .slice(0, 4);
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

  const {
    messageId,
    conversationId,
    newMessageId,
  }: {
    messageId: string;
    conversationId: string;
    newMessageId: string;
  } = await req.json();

  const tokenLedger = new DeferredTokenLedger(billing);
  const chatReferenceId = `${newMessageId}:chat`;
  try {
    const result = await tokenLedger.reserve(userData.user.email, {
      tokens: CHAT_TOKEN_COST,
      operation: 'chat',
      referenceId: chatReferenceId,
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
    await tokenLedger.releaseAll(logReservationFailure);
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
  let terminalGenerationFailed = false;

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
    await tokenLedger.releaseAll(logReservationFailure);
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

  // Non-streaming web search sub-call via OpenRouter's model-agnostic web
  // plugin. Returns a cited summary for the agent, or a failure note (the
  // agent should keep going without the facts rather than crash the turn).
  const runWebSearch = async (query: string): Promise<string> => {
    const searchAbort = new AbortController();
    const timeout = setTimeout(() => searchAbort.abort(), 30_000);
    const onOuterAbort = () => searchAbort.abort();
    abortSignal.addEventListener('abort', onOuterAbort);
    try {
      const response = await fetch(OPENROUTER_API_URL, {
        method: 'POST',
        headers: openRouterHeaders(),
        body: JSON.stringify({
          model: WEB_SEARCH_MODEL,
          plugins: [{ id: 'web', max_results: 5 }],
          messages: [
            {
              role: 'user',
              content: `Search the web and answer concisely for 3D product design research. Include concrete numbers/dimensions when available and end with the source URLs. Query: ${query.slice(0, 256)}`,
            },
          ],
          usage: { include: true },
          max_tokens: WEB_SEARCH_MAX_TOKENS,
        }),
        signal: searchAbort.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(
          `Agent-chat web_search error: ${response.status} - ${errorText.slice(0, 300)}`,
        );
        return 'Web search failed — proceed with clearly-labeled assumptions and tell the user.';
      }

      const data = await response.json();

      if (data?.usage) {
        EdgeRuntime.waitUntil(
          logLlmUsage({
            functionName: 'agent-chat',
            operation: 'chat',
            provider: 'openrouter',
            model:
              typeof data.model === 'string' && data.model
                ? data.model
                : WEB_SEARCH_MODEL,
            userId: userData.user?.id,
            conversationId,
            referenceId: newMessageId,
            inputTokens: data.usage.prompt_tokens ?? 0,
            outputTokens: data.usage.completion_tokens ?? 0,
            costUsdOverride:
              typeof data.usage.cost === 'number' ? data.usage.cost : undefined,
          }),
        );
      }

      const message = data?.choices?.[0]?.message;
      let text =
        typeof message?.content === 'string' ? message.content.trim() : '';

      // Append plugin citations not already present in the answer text.
      const annotations = Array.isArray(message?.annotations)
        ? message.annotations
        : [];
      const citationUrls = annotations
        .map(
          (annotation: { url_citation?: { url?: string } }) =>
            annotation?.url_citation?.url,
        )
        .filter(
          (url: unknown): url is string =>
            typeof url === 'string' && !!url && !text.includes(url),
        )
        .slice(0, 5);
      if (citationUrls.length > 0) {
        text += `\n\nSources: ${citationUrls.join(' ')}`;
      }

      return text
        ? text.slice(0, WEB_SEARCH_RESULT_CHAR_CAP)
        : 'Web search returned no results — proceed with clearly-labeled assumptions and tell the user.';
    } catch (error) {
      console.error('Agent-chat web_search exception:', error);
      return 'Web search failed — proceed with clearly-labeled assumptions and tell the user.';
    } finally {
      clearTimeout(timeout);
      abortSignal.removeEventListener('abort', onOuterAbort);
    }
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
    const userDesignBriefs = messagesToSend
      .filter((message) => message.role === 'user')
      .map((message) => message.content.text?.trim() ?? '')
      .filter(Boolean);

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

    const responseStream = new ReadableStream({
      async start(controller) {
        const heartbeatId = startStreamHeartbeat(controller);
        // Running conversation for the in-turn loop: rounds append their
        // assistant tool_calls + tool results here so the next Kimi call
        // sees them.
        const convo: AgentChatMessage[] = [...historyMessages];
        let webSearchesUsed = 0;
        let imagesThisTurn = 0;

        // Executes one accumulated tool call, mutating `content`. Returns the
        // tool-result text fed back to the model when the loop continues,
        // plus the fresh concept image id (for the self-review round) or
        // whether an image request was refused by the per-turn cap.
        const handleToolCall = async (toolCall: {
          id: string;
          name: string;
          arguments: string;
        }): Promise<{
          resultText: string;
          isWebSearch: boolean;
          generatedImageId: string | null;
          imageRefused: boolean;
        }> => {
          let toolInput: {
            prompt?: string;
            baseImageId?: string;
            pipeline?: string;
            reason?: string;
            generationPrompt?: string;
            query?: string;
            question?: string;
            options?: unknown;
          } = {};
          let toolInputValid = true;
          try {
            toolInput = toolCall.arguments
              ? JSON.parse(toolCall.arguments)
              : {};
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
          const clearToolCall = () => {
            content = {
              ...content,
              toolCalls:
                content.toolCalls?.filter((call) => call.id !== toolCall.id) ||
                [],
            };
          };

          let resultText = 'Tool call failed.';
          let isWebSearch = false;
          // Set when this call produced a fresh concept image — the round loop
          // feeds it back so the agent reviews its own render.
          let generatedImageId: string | null = null;
          // Set when an image request was refused by the per-turn cap — the
          // loop continues once so the agent can close with honest text
          // instead of ending the turn on its pre-tool-call sentence.
          let imageRefused = false;

          if (!toolInputValid) {
            markToolError();
          } else if (toolCall.name === 'web_search') {
            isWebSearch = true;
            if (webSearchesUsed >= MAX_WEB_SEARCHES_PER_TURN) {
              clearToolCall();
              resultText =
                'Web search limit reached for this turn — continue with what you have.';
            } else {
              webSearchesUsed += 1;
              resultText = await runWebSearch(toolInput.query ?? '');
              clearToolCall();
            }
          } else if (toolCall.name === 'generate_concept_image') {
            if (imagesThisTurn >= MAX_IMAGES_PER_TURN) {
              clearToolCall();
              imageRefused = true;
              resultText =
                'Image limit reached for this turn — reply to the user with the current image and what you would still change; do not promise another render this turn.';
            } else {
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
                    prompt: buildAgentConceptImagePrompt(toolInput.prompt),
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
                  resultText =
                    'Image generation failed: the user is out of tokens.';
                } else {
                  markToolError();
                  resultText = 'Image generation failed.';
                }
              } else if (typeof data?.id === 'string') {
                imagesThisTurn += 1;
                clearToolCall();
                content = {
                  ...content,
                  images: [...(content.images ?? []), data.id],
                };
                generatedImageId = data.id;
                resultText = `Concept image generated with id ${data.id} and shown to the user. It follows below for your review.`;
              } else {
                markToolError();
                resultText = 'Image generation failed.';
              }
            }
          } else if (toolCall.name === 'ask_user') {
            const questionText = (toolInput.question ?? '')
              .trim()
              .slice(0, 300);
            const options = sanitizeQuestionOptions(toolInput.options);
            if (questionText && options.length >= 2) {
              clearToolCall();
              content = {
                ...content,
                question: { text: questionText, options },
              };
              resultText = 'Question with options shown to the user.';
            } else {
              markToolError();
              resultText =
                'ask_user failed: provide a question and 2-4 options.';
            }
          } else if (toolCall.name === 'recommend_pipeline') {
            const pipeline = normalizeAgentPipeline(toolInput.pipeline);
            if (pipeline) {
              clearToolCall();
              content = {
                ...content,
                recommendation: {
                  pipeline,
                  ...(toolInput.reason ? { reason: toolInput.reason } : {}),
                  ...(toolInput.generationPrompt
                    ? { generationPrompt: toolInput.generationPrompt }
                    : {}),
                },
              };
              resultText =
                'Recommendation recorded; the Generate button is shown to the user.';
            } else {
              markToolError();
              resultText = 'recommend_pipeline failed: invalid pipeline.';
            }
          } else {
            markToolError();
          }

          streamMessage(controller, { ...newMessageData, content });
          await persistContent(content);

          return { resultText, isWebSearch, generatedImageId, imageRefused };
        };

        try {
          for (let round = 0; round < MAX_AGENT_ROUNDS; round++) {
            const requestBody = {
              model: AGENT_MODEL,
              messages: [
                { role: 'system' as const, content: systemPrompt },
                ...convo,
              ],
              tools,
              stream: true,
              usage: { include: true },
              max_tokens: AGENT_MAX_TOKENS,
              reasoning: { effort: AGENT_REASONING_EFFORT },
            };

            trace('before_openrouter_stream', {
              model: AGENT_MODEL,
              round,
              messagesCount: requestBody.messages.length,
              hasKey: !!OPENROUTER_API_KEY,
            });

            const pendingToolCalls = new Map<
              number,
              { id: string; name: string; arguments: string }
            >();
            let lastToolCallIndex = 0;
            let servedModel = AGENT_MODEL;
            let roundText = '';
            let addedRoundSeparator = false;

            // Deadline for this round's fetch + stream read: a stalled
            // provider stream must surface as an error instead of an
            // infinite client spinner.
            const roundAbort = new AbortController();
            const roundTimer = setTimeout(
              () => roundAbort.abort(new Error('agent round timeout')),
              ROUND_DEADLINE_MS,
            );
            const onOuterAbort = () => roundAbort.abort();
            abortSignal.addEventListener('abort', onOuterAbort);

            try {
              const response = await fetchKimiK3ChatCompletion(
                requestBody,
                roundAbort.signal,
              );

              if (!response.ok) {
                const errorText = await response.text();
                console.error(
                  `OpenRouter API Error: ${response.status} - ${errorText.slice(0, 500)}`,
                );
                if (
                  response.status === 429 &&
                  errorText.toLowerCase().includes('provider returned error')
                ) {
                  throw new UserFacingAgentError(
                    'Kimi K3 is temporarily at capacity. Please retry in a moment.',
                  );
                }
                throw new Error(
                  `OpenRouter API error: ${response.statusText} (${response.status})`,
                );
              }

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
                    // Separate the text of a post-web-search round from the
                    // text streamed before the search.
                    if (
                      !addedRoundSeparator &&
                      round > 0 &&
                      content.text &&
                      !content.text.endsWith('\n\n')
                    ) {
                      content = { ...content, text: content.text + '\n\n' };
                    }
                    addedRoundSeparator = true;
                    roundText += delta.content;
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
                        streamMessage(controller, {
                          ...newMessageData,
                          content,
                        });
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
            } finally {
              clearTimeout(roundTimer);
              abortSignal.removeEventListener('abort', onOuterAbort);
            }

            if (pendingToolCalls.size === 0) {
              // Plain reply — the turn is done.
              break;
            }

            const orderedToolCalls = [...pendingToolCalls.entries()]
              .sort(([a], [b]) => a - b)
              .map(([, call]) => call);

            const toolResults: Array<{ id: string; text: string }> = [];
            let roundHadWebSearch = false;
            let roundImageRefused = false;
            const roundImageIds: string[] = [];
            for (const toolCall of orderedToolCalls) {
              if (abortSignal.aborted) break;
              const {
                resultText,
                isWebSearch,
                generatedImageId,
                imageRefused,
              } = await handleToolCall(toolCall);
              toolResults.push({ id: toolCall.id, text: resultText });
              roundHadWebSearch = roundHadWebSearch || isWebSearch;
              roundImageRefused = roundImageRefused || imageRefused;
              if (generatedImageId) roundImageIds.push(generatedImageId);
            }

            // Load this round's fresh render(s) so the agent can review its
            // own work (same base64 data-URL pattern as history replay —
            // multimodal tool-role results are unreliable across providers,
            // so the pixels go in a follow-up user message instead).
            let reviewImageParts: AgentContentPart[] = [];
            if (roundImageIds.length > 0 && !abortSignal.aborted) {
              const base64Images = await getBase64Images(
                supabaseClient,
                'images',
                roundImageIds.map(
                  (imageId) =>
                    `${userData.user.id}/${conversationId}/${imageId}`,
                ),
              );
              reviewImageParts = base64Images.map((image) => ({
                type: 'image_url' as const,
                image_url: { url: image.data },
              }));
            }

            // web_search continues the in-turn loop, and so does a generated
            // concept image (the agent reviews the render and may redo it) or
            // a cap-refused image request (one closing text round). ask_user
            // and recommend_pipeline end the turn and wait for the user; an
            // image whose bytes could not be loaded ends the turn as before.
            const shouldContinue =
              !abortSignal.aborted &&
              !content.question &&
              !content.recommendation &&
              (roundHadWebSearch ||
                roundImageRefused ||
                reviewImageParts.length > 0);
            if (!shouldContinue) {
              break;
            }

            convo.push({
              role: 'assistant',
              content: roundText,
              tool_calls: orderedToolCalls.map((call) => ({
                id: call.id,
                type: 'function' as const,
                function: { name: call.name, arguments: call.arguments },
              })),
            });
            for (const result of toolResults) {
              convo.push({
                role: 'tool',
                tool_call_id: result.id,
                content: result.text,
              });
            }
            if (reviewImageParts.length > 0) {
              convo.push({
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: '[Automated] This is the concept image your tool call just generated, exactly as shown to the user. Review it against the user’s request, the 3D-printability rules, and the render art direction: one connected piece, nothing floating or detached, no unprintably thin features, and an unmistakable dimensional 3D-object render rather than a lifestyle photo or flat artwork. For a practical CAD part, require a clear three-quarter engineering-product view with readable solid geometry. If it clearly fails, call generate_concept_image again now — baseImageId for small fixes, fresh for a wrong concept. If it passes and the design is fully specified or the user asked you to recommend/generate, call recommend_pipeline now with the complete generation prompt; never merely name the recommended pipeline in prose. Otherwise, briefly ask what the user would like to change.',
                  },
                  ...reviewImageParts,
                ],
              });
            }
          }
        } catch (error) {
          terminalGenerationFailed = true;
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
              !!content.question ||
              !!content.recommendation);

          if (!hasNonDefaultContent) {
            await tokenLedger.releaseAll(logReservationFailure);
            if (abortSignal.aborted) {
              content = {
                ...content,
                text: 'Generation stopped! Retry or enter a new prompt.',
              };
            } else {
              content = {
                ...content,
                text:
                  error instanceof UserFacingAgentError
                    ? error.message
                    : 'An error occurred while processing your request.',
              };
            }
          }
        } finally {
          clearInterval(heartbeatId);
          if (
            !abortSignal.aborted &&
            !content.question &&
            !content.recommendation
          ) {
            const fallbackRecommendation = buildFallbackRecommendation({
              assistantText: content.text,
              userBriefs: userDesignBriefs,
              hasConceptImage: !!content.images?.length,
            });
            if (fallbackRecommendation) {
              content = {
                ...content,
                recommendation: fallbackRecommendation,
              };
            }
          }

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
          let finalMessageData = await persistContent(content);

          const hasDeliverableContent = Boolean(
            content.text?.trim() ||
            content.images?.length ||
            content.question ||
            content.recommendation,
          );
          if (
            !finalMessageData ||
            terminalGenerationFailed ||
            abortSignal.aborted ||
            !hasDeliverableContent
          ) {
            await tokenLedger.releaseAll(logReservationFailure);
          } else {
            const settlement =
              await tokenLedger.commitReference(chatReferenceId);
            if (!settlement.ok) {
              await tokenLedger.releaseAll(logReservationFailure);
              content = {
                error:
                  settlement.reason === 'insufficient_tokens'
                    ? 'insufficient_tokens'
                    : 'billing_unavailable',
              };
              finalMessageData = await persistContent(content);
            }
          }

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
        !!content.question ||
        !!content.recommendation);

    await tokenLedger.releaseAll(logReservationFailure);
    if (!hasNonDefaultContent) {
      content = {
        ...content,
        text: abortSignal.aborted
          ? 'Generation stopped! Retry or enter a new prompt.'
          : error instanceof UserFacingAgentError
            ? error.message
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
