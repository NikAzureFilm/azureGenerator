// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { corsHeaders } from '../_shared/cors.ts';
import 'jsr:@std/dotenv/load';
import { getAnonSupabaseClient } from '../_shared/supabaseClient.ts';
import { billing, BillingClientError } from '../_shared/billingClient.ts';
import {
  RefundableTokenLedger,
  type RefundFailure,
} from '../_shared/refundableTokenLedger.ts';
import { FEATURE_COSTS } from '../../../shared/tokenCosts.ts';
import { logLlmUsage } from '../_shared/providerUsage.ts';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_API_KEY = Deno.env.get('OPENROUTER_API_KEY') ?? '';
const PROMPT_GENERATOR_MODEL = 'openai/gpt-5.5';
const PROMPT_GENERATOR_FALLBACK_MODEL = 'anthropic/claude-haiku-4.5';
const PROMPT_GENERATOR_TOKEN_COST = FEATURE_COSTS.promptGeneration.tokens;

type OpenRouterMessageContent =
  | string
  | Array<{
      type?: string;
      text?: string;
    }>;

interface OpenRouterChatCompletion {
  model?: string;
  choices?: Array<{
    message?: {
      content?: OpenRouterMessageContent;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number;
  };
  error?: {
    message?: string;
  };
}

function extractGeneratedText(response: OpenRouterChatCompletion): string {
  const content = response.choices?.[0]?.message?.content;

  if (typeof content === 'string') {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => (part.type === 'text' || !part.type ? part.text : ''))
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  return '';
}

function isInvalidModelResponse(errorText: string, model: string): boolean {
  return (
    errorText.toLowerCase().includes('not a valid model id') &&
    errorText.includes(model)
  );
}

const logRefundFailure = ({ error, charge }: RefundFailure) => {
  console.error('Error refunding prompt generator tokens:', {
    error,
    userId: charge.body.userId,
    operation: charge.body.operation,
    referenceId: charge.body.referenceId,
    tokens: charge.body.tokens,
  });
};

const PROMPT_SYSTEM_PROMPT = `You are a helpful assistant that generates creative prompts for organic 3D forms and artistic objects. Your prompts should be:
1. Focus on organic shapes, characters, figurines, artistic forms, and 3D printable assets
2. Be short and creative
3. Avoid technical dimensions - focus on form and aesthetics
4. Think sculptures, characters, animals, artistic objects
5. Prefer watertight forms with stable build plate contact, practical minimum wall thickness, and no fragile paper-thin details
6. Return ONLY the prompt text without any introductory phrases or quotes

Here are some examples:

User: "Generate a creative prompt for a 3D form."
Assistant: "a table top figurine of sonic the hedgehog"
User: "Generate a creative prompt for a 3D form."
Assistant: "a dragon sculpture with spread wings"
User: "Generate a creative prompt for a 3D form."
Assistant: "a decorative elephant statue"
User: "Generate a creative prompt for a 3D form."
Assistant: "a cartoon character bust of mario"
User: "Generate a creative prompt for a 3D form."
Assistant: "a stylized tree with twisted branches"
User: "Generate a creative prompt for a 3D form."
Assistant: "a miniature castle with towers"
User: "Generate a creative prompt for a 3D form."
Assistant: "a wise owl guardian perched on an open book"
User: "Generate a creative prompt for a 3D form."
Assistant: "a sleepy fox curled around a crescent moon base"
User: "Generate a creative prompt for a 3D form."
Assistant: "a mushroom village lantern with hollow windows"
User: "Generate a creative prompt for a 3D form."
Assistant: "a sea turtle swimming above a coral-shaped pedestal"
User: "Generate a creative prompt for a 3D form."
Assistant: "a friendly robot gardener holding a tiny sprout"
User: "Generate a creative prompt for a 3D form."
Assistant: "two koi fish spiraling into a yin-yang sculpture"
User: "Generate a creative prompt for a 3D form."
Assistant: "a forest spirit mask framed by layered leaves"
User: "Generate a creative prompt for a 3D form."
Assistant: "an astronaut cat waving from a cratered moon"
User: "Generate a creative prompt for a 3D form."
Assistant: "a phoenix rising from a stylized flame base"
User: "Generate a creative prompt for a 3D form."
Assistant: "a steampunk octopus with curled mechanical tentacles"
User: "Generate a creative prompt for a 3D form."
Assistant: "a low-poly mountain goat standing on a rocky base"
User: "Generate a creative prompt for a 3D form."
Assistant: "a whimsical teapot house with a rounded front door"
User: "Generate a creative prompt for a 3D form."
Assistant: "a gothic raven bust with folded wings"
User: "Generate a creative prompt for a 3D form."
Assistant: "a baby triceratops hatching from a cracked egg"
User: "Generate a creative prompt for a 3D form."
Assistant: "an abstract human face flowing into ocean waves"
`;

const PARAMETRIC_SYSTEM_PROMPT = `You are a helpful assistant that generates prompts for dimensional household objects and functional parts. Your prompts should be:
1. Focus on practical household items, functional parts, and 3D printable assets
2. Include specific dimensions when relevant
3. Be concise and practical
4. Think containers, holders, brackets, everyday objects
5. Include printable constraints when useful: stable build plate orientation, practical minimum wall thickness of 1.2 mm or thicker, and clearances for moving or mating parts
6. Return ONLY the prompt text without any introductory phrases or quotes

Here are some examples:

User: "Generate a parametric modeling prompt."
Assistant: "a plant pot with 4 drainage holes and a 30mm diameter"
User: "Generate a parametric modeling prompt."
Assistant: "a phone stand with 15 degree angle and cable slot"
User: "Generate a parametric modeling prompt."
Assistant: "a pen holder cup 80mm diameter with pencil slots"
User: "Generate a parametric modeling prompt."
Assistant: "a wall bracket 120mm wide with two 6mm screw holes"
User: "Generate a parametric modeling prompt."
Assistant: "a drawer organizer tray 200x100mm with compartments"
User: "Generate a parametric modeling prompt."
Assistant: "a cable management clip for 8mm cables"
User: "Generate a parametric modeling prompt."
Assistant: "a stackable parts bin 120x80x60mm with a front scoop and label slot"
User: "Generate a parametric modeling prompt."
Assistant: "an adjustable bookend with a 140mm sliding dovetail base and 0.3mm clearance"
User: "Generate a parametric modeling prompt."
Assistant: "a 250mm tall headphone stand with a 120mm base and cable notch"
User: "Generate a parametric modeling prompt."
Assistant: "a 40mm desk cable grommet with a snap-fit rotating cap"
User: "Generate a parametric modeling prompt."
Assistant: "a 160x80mm drill bit organizer with labeled holes from 2mm to 12mm"
User: "Generate a parametric modeling prompt."
Assistant: "a three-tier spice rack 300mm wide with 55mm deep shelves"
User: "Generate a parametric modeling prompt."
Assistant: "a wall-mounted key holder 180mm wide with six hooks and two 5mm screw holes"
User: "Generate a parametric modeling prompt."
Assistant: "an eight-cell AA battery dispenser with a gravity-fed output slot"
User: "Generate a parametric modeling prompt."
Assistant: "a 110x75mm soap dish with drainage slots and four raised feet"
User: "Generate a parametric modeling prompt."
Assistant: "a 67mm camera lens cap with flexible snap tabs and 0.25mm clearance"
User: "Generate a parametric modeling prompt."
Assistant: "a 100mm radius angle gauge marked from 0 to 90 degrees"
User: "Generate a parametric modeling prompt."
Assistant: "a reinforced 50x50x30mm corner bracket with four 5mm screw holes"
User: "Generate a parametric modeling prompt."
Assistant: "a 4x6 seed starter tray with 45mm cells and two drainage holes per cell"
User: "Generate a parametric modeling prompt."
Assistant: "a modular hexagonal drawer divider 50mm across flats with clip connectors"
User: "Generate a parametric modeling prompt."
Assistant: "a pegboard screwdriver holder for 25mm hole spacing with eight tool slots"
`;

// Main server function handling incoming requests
Deno.serve(async (req) => {
  const tokenLedger = new RefundableTokenLedger(billing);
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  // Ensure only POST requests are accepted
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const supabaseClient = getAnonSupabaseClient({
    global: {
      headers: { Authorization: req.headers.get('Authorization') ?? '' },
    },
  });

  const { data: userData, error: userError } =
    await supabaseClient.auth.getUser();

  if (!userData.user) {
    return new Response(
      JSON.stringify({ error: { message: 'Unauthorized' } }),
      {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      },
    );
  }

  if (userError) {
    return new Response(
      JSON.stringify({ error: { message: userError.message } }),
      {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      },
    );
  }

  // Parse request body to get existing text and type if provided
  const {
    existingText,
    type,
  }: { existingText?: string; type?: 'parametric' | 'creative' } = await req
    .json()
    .catch(() => ({}));

  try {
    if (!OPENROUTER_API_KEY.trim()) {
      throw new Error('OPENROUTER_API_KEY is not configured');
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

    try {
      const consumeResult = await tokenLedger.consume(userData.user.email, {
        tokens: PROMPT_GENERATOR_TOKEN_COST,
        operation: 'chat',
        referenceId: crypto.randomUUID(),
        userId: userData.user.id,
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
      console.error('Error consuming prompt generator tokens:', err);
      return new Response(
        JSON.stringify({
          error: {
            message: 'billing_unavailable',
            code: 'billing_unavailable',
          },
        }),
        {
          status,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
    }

    let systemPrompt: string;
    let userPrompt: string;

    if (existingText && existingText.length > 0) {
      // Augment existing text
      if (type === 'parametric') {
        systemPrompt = `You are a technical writing assistant specialized in enhancing prompts for dimensional household objects and functional parts. When given an existing prompt, you should:

1. Add specific dimensions (in mm) where practical and missing
2. Include functional details like holes, slots, angles, or compartments
3. Focus on practical household use cases and functionality
4. Make it more precise for creating useful everyday objects
5. Include practical 3D printable constraints such as build plate orientation, minimum wall thickness of 1.2 mm or thicker, and clearances for moving or mating parts
6. Maintain the original intent and core concept
7. Keep it concise and practical
8. Return ONLY the enhanced prompt text without any introductory phrases, explanations, or quotes

The enhanced prompt should be more functional and dimensional while staying true to the user's vision.`;

        userPrompt = `Please enhance and expand this household object prompt to make it more functional, dimensional, and practical for everyday use:

${JSON.stringify(existingText)}

Return only the enhanced prompt text, no introductory phrases.`;
      } else {
        // Creative mode augmentation
        systemPrompt = `You are a creative writing assistant specialized in enhancing prompts for 3D game assets and 3D printable characters. When given an existing prompt, you should:

1. Expand with more vivid artistic and organic details
2. Add character traits, poses, or artistic styling
3. Include sculptural or decorative elements
4. Focus on form, aesthetics, visual appeal, and 3D printable structure
5. Avoid fragile paper-thin details; prefer stable build plate contact and practical minimum wall thickness
6. Maintain the original intent and core concept
7. Make it more engaging and visually interesting
8. Return ONLY the enhanced prompt text without any introductory phrases, explanations, or quotes

The enhanced prompt should be more artistic and visually compelling while staying true to the user's vision.`;

        userPrompt = `Please enhance and expand this artistic 3D form prompt to make it more detailed, creative, and visually compelling:

${JSON.stringify(existingText)}

Return only the enhanced prompt text, no introductory phrases.`;
      }
    } else {
      // Generate new prompt
      if (type === 'parametric') {
        systemPrompt = PARAMETRIC_SYSTEM_PROMPT;
        userPrompt = 'Generate a parametric modeling prompt.';
      } else {
        systemPrompt = PROMPT_SYSTEM_PROMPT;
        userPrompt = 'Generate a creative prompt for a 3D form.';
      }
    }

    const requestBody = {
      model: PROMPT_GENERATOR_MODEL,
      max_completion_tokens: 200,
      // Ask OpenRouter to return token usage (and its own billed cost).
      usage: { include: true },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    };
    let usedModel: string = PROMPT_GENERATOR_MODEL;

    const requestPrompt = (body: typeof requestBody) =>
      fetch(OPENROUTER_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          'HTTP-Referer': 'https://azurefilm.com',
          'X-Title': 'AzureFilm Generator',
        },
        body: JSON.stringify(body),
      });

    let response = await requestPrompt(requestBody);

    if (!response.ok) {
      const errorText = await response.text();
      if (isInvalidModelResponse(errorText, PROMPT_GENERATOR_MODEL)) {
        console.warn(
          `${PROMPT_GENERATOR_MODEL} is not available on OpenRouter; retrying with ${PROMPT_GENERATOR_FALLBACK_MODEL}`,
        );
        usedModel = PROMPT_GENERATOR_FALLBACK_MODEL;
        response = await requestPrompt({
          ...requestBody,
          model: PROMPT_GENERATOR_FALLBACK_MODEL,
        });
      }
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `OpenRouter API error: ${response.statusText} (${response.status}) - ${errorText}`,
      );
    }

    const completion = (await response.json()) as OpenRouterChatCompletion;

    if (completion.error?.message) {
      throw new Error(completion.error.message);
    }

    EdgeRuntime.waitUntil(
      logLlmUsage({
        functionName: 'prompt-generator',
        operation: 'prompt',
        provider: 'openrouter',
        model: completion.model ?? usedModel,
        userId: userData.user.id,
        inputTokens: completion.usage?.prompt_tokens ?? 0,
        outputTokens: completion.usage?.completion_tokens ?? 0,
        costUsdOverride:
          typeof completion.usage?.cost === 'number'
            ? completion.usage.cost
            : undefined,
      }),
    );

    const prompt = extractGeneratedText(completion);

    if (!prompt) {
      throw new Error('No prompt generated');
    }

    return new Response(JSON.stringify({ prompt }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Error generating prompt:', error);
    await tokenLedger.refundAll(logRefundFailure);

    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : 'Unknown error',
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      },
    );
  }
});
