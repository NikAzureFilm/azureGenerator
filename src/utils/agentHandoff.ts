import type { AgentPipeline } from '@shared/types';
import { appendFlatBottomPrompt } from '@shared/flatBottom';

export const SINGLE_PIECE_HANDOFF_REQUIREMENT =
  'Single-piece output requirement: Generate exactly one contiguous, connected, watertight 3D-printable object. Every feature must physically overlap the body it attaches to. Do not create or display separate parts, an exploded view, a kit, loose accessories, or multiple objects.';

export function buildAgentHandoffPrompt(
  prompt: string,
  pipeline: AgentPipeline,
  // Restates the flat-bottom requirement for the pipeline that actually
  // generates the model. The recommendation prompt usually carries it already
  // (agent-chat appends it server-side), so the append is idempotent.
  flatBottom = false,
): string {
  // Fallback first: an empty prompt must still describe the object, never
  // degrade to the bare flat-bottom sentence.
  const basePrompt = appendFlatBottomPrompt(
    prompt.trim() || 'Generate the object we designed.',
    flatBottom,
  );

  if (
    pipeline === 'multiview' ||
    basePrompt.includes(SINGLE_PIECE_HANDOFF_REQUIREMENT)
  ) {
    return basePrompt;
  }

  return `${basePrompt}\n\n${SINGLE_PIECE_HANDOFF_REQUIREMENT}`;
}
