import {
  THREE_D_OBJECT_PROMPT_ENFORCEMENT,
  enforce3DObjectPrompt,
} from './imagePrompt.ts';

export type ViewLabel = 'front' | 'left' | 'back' | 'right';

export type ImageGenerationMode = 'input' | 'multiview';

export const VIEW_DIRECTIVE: Record<ViewLabel, string> = {
  front:
    'Camera directly in front of the object at eye level. The object faces the camera head-on. Do not show the left or right side profile.',
  left: 'Camera directly to the left side of the object: rotate 90 degrees counter-clockwise from the front view around the vertical axis. Show the true left-side profile silhouette. If a right-side profile reference is attached, use it only for identity and proportions; do not duplicate or mirror it.',
  back: 'Camera directly behind the object, 180 degrees from front. Show the true back of the object.',
  right:
    'Camera directly to the right side of the object: rotate 90 degrees clockwise from the front view around the vertical axis. Show the true right-side profile silhouette, the opposite side of the object from the left profile. If a left-side profile reference is attached, use it only for identity and proportions; do not duplicate or mirror it.',
};

const BASE_VIEW_INSTRUCTIONS =
  'Output a single centered 3D object asset on a pure white or transparent-looking cutout background with flat diffuse shadowless ambient lighting and no floor plane or ground plane. No cast shadows, no ground shadows, no contact shadows, no ambient occlusion, no vignette, no directional key light, and no baked-in shadow marks on the object or texture. Do not add any gray shadow patch beneath the feet, tail, base, or any part of the object. Keep the whole object in-frame with 5-10% padding, no cropping, no text, no labels, no logos, no UI, no scenery, and no flat 2D illustration.';

export const buildReferenceContext = (referenceLabels: string[]): string => {
  const cleanedLabels = referenceLabels
    .map((label) => label.trim())
    .filter(Boolean);

  if (cleanedLabels.length === 0) return '';

  return `Reference images are attached in this order: ${cleanedLabels.join(', ')}.`;
};

export const buildImageGenerationPrompt = ({
  view,
  userPrompt,
  hasReference,
  mode,
  referenceLabels,
}: {
  view: ViewLabel;
  userPrompt: string;
  hasReference: boolean;
  mode: ImageGenerationMode;
  referenceLabels?: string[];
}): string => {
  const cleanPrompt = userPrompt.trim();
  let workflowPrompt: string;

  if (mode === 'input') {
    workflowPrompt = hasReference
      ? `${BASE_VIEW_INSTRUCTIONS} Re-render the reference as a clean 3D-ready object input image. Preserve the main object's identity, proportions, colors, geometry, and materials. ${cleanPrompt ? `Additional guidance: ${cleanPrompt}` : ''}`.trim()
      : `${BASE_VIEW_INSTRUCTIONS} Generate a 3D-ready object rendering of: ${cleanPrompt || 'a simple centered 3D asset'}.`;
  } else {
    const viewDirective = VIEW_DIRECTIVE[view];
    const referenceContext = buildReferenceContext(referenceLabels ?? []);
    workflowPrompt = hasReference
      ? `${BASE_VIEW_INSTRUCTIONS} ${referenceContext} Re-render the SAME 3D object shown in the reference image from a different angle: ${viewDirective} Preserve the object's identity, geometry, proportions, colors, and materials exactly. Only the viewing angle changes. ${cleanPrompt ? `Additional guidance: ${cleanPrompt}` : ''}`.trim()
      : `${BASE_VIEW_INSTRUCTIONS} Generate a 3D-ready object rendering of: ${cleanPrompt || 'a simple centered 3D asset'}. ${viewDirective}`;
  }

  return enforce3DObjectPrompt(
    `${THREE_D_OBJECT_PROMPT_ENFORCEMENT} ${workflowPrompt}`,
  );
};
