/**
 * Flat-bottom option: the generated model should sit on a single flat planar
 * underside (like a fish sculpt sliced along its belly) so it prints on the bed
 * without supports and stands on a shelf without tipping.
 *
 * Two independent layers enforce it and this module owns the wording for both:
 *   1. Generation side — these directives steer the concept image (mesh mode,
 *      design-agent renders) and the downstream generation prompt so the model
 *      is *designed* with a flat underside.
 *   2. Geometry side — `src/utils/flatBottomCut.ts` actually trims the
 *      underside with a planar cut, which is what *guarantees* the result.
 *
 * Shared between the Vite client (`@shared/flatBottom`) and the Deno edge
 * functions (`@shared/flatBottom.ts`), so both surfaces phrase it identically.
 *
 * NOTE: deliberately unrelated to the removed "mesh base" feature (which added
 * a separate display plinth under the subject). Never name anything here
 * `meshBase` — supabase/functions/{mesh,creative-chat}/meshBase.test.mjs are
 * regression guards that fail on that substring.
 */

/** Steers concept-image generation: how the object must be shaped. */
export const FLAT_BOTTOM_IMAGE_DIRECTIVE =
  'Flat bottom requirement: shape the subject so its entire underside is one single flat horizontal plane, as if the bottom had been sliced off level, and show it resting squarely on that flat underside on the surface. The flat underside must be broad enough for the object to stand stably on its own, with no rounded belly, no feet, legs, fins, or points touching down separately, no pedestal or added base, and nothing protruding below that plane.';

/** Appended to text prompts handed to a downstream mesh/CAD generation. */
export const FLAT_BOTTOM_PROMPT_SUFFIX =
  'Give it a flat bottom: the whole underside must be one single flat plane it rests on, sliced level, with nothing sticking out below it.';

/** Design-agent system-prompt clause, phrased as a design rule. */
export const FLAT_BOTTOM_AGENT_RULE =
  'FLAT BOTTOM (required): every design must have one single flat planar underside that it rests on — imagine the bottom sliced off level. The flat face has to be broad enough for the object to stand stably. No rounded undersides, no separate feet or legs touching down, no added plinth, nothing protruding below that plane. Say so in every concept-image prompt you write and in the final generation prompt.';

/**
 * Matches a prompt that already asks for a flat bottom/base/underside, so the
 * directive is not stacked on top of the user's own wording.
 */
const FLAT_BOTTOM_PATTERN =
  /\bflat[-\s]?(bottom|bottomed|base|based|underside|bed)\b/i;

/**
 * Append the flat-bottom instruction to a user/generation prompt, idempotently.
 * Mirrors `buildCadSubmitText`'s contract: returns the trimmed prompt untouched
 * when the option is off or the prompt already asks for a flat bottom.
 */
export function appendFlatBottomPrompt(
  prompt: string | undefined,
  flatBottom: boolean | undefined,
): string {
  const trimmed = prompt?.trim() ?? '';
  if (!flatBottom) return trimmed;
  if (!trimmed) return FLAT_BOTTOM_PROMPT_SUFFIX;
  if (FLAT_BOTTOM_PATTERN.test(trimmed)) return trimmed;
  return `${trimmed}. ${FLAT_BOTTOM_PROMPT_SUFFIX}`;
}

/**
 * Prefix an image-generation prompt with the flat-bottom art direction,
 * idempotently (the mesh function's provider fallback chain re-wraps the same
 * prompt once per attempt, and the agent path wraps it again downstream).
 */
export function applyFlatBottomImageDirective(
  prompt: string,
  flatBottom: boolean | undefined,
): string {
  if (!flatBottom) return prompt;
  if (prompt.includes(FLAT_BOTTOM_IMAGE_DIRECTIVE)) return prompt;
  return `${FLAT_BOTTOM_IMAGE_DIRECTIVE} ${prompt}`;
}
