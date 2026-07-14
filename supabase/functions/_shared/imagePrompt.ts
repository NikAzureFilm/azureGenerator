export const THREE_D_OBJECT_PROMPT_ENFORCEMENT =
  'Mandatory output: a single centered 3D model, 3D object, or 3D character asset, fully textured and rendered with visible depth, form, volume, materials, and a soft ground shadow. Use a plain white or transparent-looking studio background, keep the whole object in frame, and include no text, labels, UI, logos, scenery, or flat 2D illustration. If the user asks for a photo, poster, scene, logo, icon, product ad, or 2D artwork, convert the subject into one standalone physical 3D object asset instead. Design the subject as one contiguous physical piece: every element must be attached to or touching the main body, with no floating, hovering, or detached parts, so it can be 3D printed as a single connected object. The result must look like a render of a physical 3D model, not a flat 2D illustration, photo, poster, or concept sketch.';

export const AGENT_CONCEPT_IMAGE_PROMPT_ENFORCEMENT =
  'Agent concept-image art direction: render one standalone object as a polished 3D CAD or 3D asset visualization, never as a photograph of an object in a real environment, lifestyle scene, sketch, diagram, collage, or flat artwork. Use a slightly elevated three-quarter isometric camera that clearly reveals the front, side, and top, with realistic perspective, visible thickness and depth, a crisp silhouette, studio lighting, subtle edge highlights, and a soft contact shadow on a clean white background. For practical, functional, dimensioned, mechanical, or CAD-style parts, use coherent manufacturable engineering geometry with plausible wall thicknesses, clean openings, holes and channels, gently filleted edges and transitions where appropriate, and a neutral matte graphite or dark-gray solid CAD material, like a premium CAD product render. Keep organic, character, and decorative subjects faithful to their requested colors and materials, but still present them as unmistakable three-dimensional object assets.';

export function enforce3DObjectPrompt(prompt: string | undefined): string {
  const trimmedPrompt = prompt?.trim() || 'Generate a 3D object.';

  if (trimmedPrompt.includes(THREE_D_OBJECT_PROMPT_ENFORCEMENT)) {
    return trimmedPrompt;
  }

  return `${THREE_D_OBJECT_PROMPT_ENFORCEMENT} User request: ${trimmedPrompt}`;
}

export function buildAgentConceptImagePrompt(
  prompt: string | undefined,
): string {
  const trimmedPrompt = prompt?.trim() || 'Generate a simple 3D object.';

  if (trimmedPrompt.includes(AGENT_CONCEPT_IMAGE_PROMPT_ENFORCEMENT)) {
    return trimmedPrompt;
  }

  return `${AGENT_CONCEPT_IMAGE_PROMPT_ENFORCEMENT} Object description: ${trimmedPrompt}`;
}
