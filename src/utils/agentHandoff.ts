import type { AgentPipeline } from '@shared/types';

export const SINGLE_PIECE_HANDOFF_REQUIREMENT =
  'Single-piece output requirement: Generate exactly one contiguous, connected, watertight 3D-printable object. Every feature must physically overlap the body it attaches to. Do not create or display separate parts, an exploded view, a kit, loose accessories, or multiple objects.';

export function buildAgentHandoffPrompt(
  prompt: string,
  pipeline: AgentPipeline,
): string {
  const basePrompt = prompt.trim() || 'Generate the object we designed.';

  if (
    pipeline === 'multiview' ||
    basePrompt.includes(SINGLE_PIECE_HANDOFF_REQUIREMENT)
  ) {
    return basePrompt;
  }

  return `${basePrompt}\n\n${SINGLE_PIECE_HANDOFF_REQUIREMENT}`;
}
