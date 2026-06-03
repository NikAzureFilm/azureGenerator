export const THREE_D_OBJECT_PROMPT_ENFORCEMENT =
  'Mandatory output: a single centered 3D model, 3D object, or 3D character asset, fully textured and rendered with visible depth, form, volume, and materials under flat diffuse shadowless ambient lighting. Use a pure white or transparent-looking cutout background with no floor plane or ground plane. No cast shadows, no ground shadows, no contact shadows, no ambient occlusion, no vignette, no directional key light, and no baked-in shadow marks on the model or texture. Do not add any gray shadow patch beneath the feet, tail, base, or any part of the object. Keep the whole object in frame, and include no text, labels, UI, logos, scenery, or flat 2D illustration. If the user asks for a photo, poster, scene, logo, icon, product ad, or 2D artwork, convert the subject into one standalone physical 3D object asset instead. The result must look like a clean shadowless reference render of a physical 3D model, not a flat 2D illustration, photo, poster, or concept sketch.';

export function enforce3DObjectPrompt(prompt: string | undefined): string {
  const trimmedPrompt = prompt?.trim() || 'Generate a 3D object.';

  if (trimmedPrompt.includes(THREE_D_OBJECT_PROMPT_ENFORCEMENT)) {
    return trimmedPrompt;
  }

  return `${THREE_D_OBJECT_PROMPT_ENFORCEMENT} User request: ${trimmedPrompt}`;
}
