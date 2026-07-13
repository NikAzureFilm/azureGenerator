import type { AgentPipeline, AgentRecommendation } from '@shared/types.ts';

const SINGLE_PIECE_REQUIREMENT =
  'Single-piece output requirement: Generate exactly one contiguous, connected, watertight 3D-printable object. Every feature must physically overlap the body it attaches to. Do not create or display separate parts, an exploded view, a kit, loose accessories, or multiple objects.';

const PLAIN_TEXT_RECOMMENDATION =
  /\brecommend(?:ed|ing|ation)?\b[\s\S]{0,80}?\b(cad|mesh|multiview)\b/i;

export function buildFallbackRecommendation({
  assistantText,
  userBriefs,
  hasConceptImage,
}: {
  assistantText?: string;
  userBriefs: string[];
  hasConceptImage: boolean;
}): AgentRecommendation | null {
  if (!hasConceptImage || !assistantText) return null;

  const match = assistantText.match(PLAIN_TEXT_RECOMMENDATION);
  if (!match) return null;

  const pipeline = match[1].toLowerCase() as AgentPipeline;
  const designBrief = userBriefs
    .map((brief) => brief.trim())
    .filter(Boolean)
    .join('\n\n')
    .slice(-6000);
  const basePrompt = designBrief || assistantText.trim();
  const generationPrompt = basePrompt.includes(SINGLE_PIECE_REQUIREMENT)
    ? basePrompt
    : `${basePrompt}\n\n${SINGLE_PIECE_REQUIREMENT}`;

  return {
    pipeline,
    reason: `The design agent recommended the ${pipeline.toUpperCase()} pipeline after reviewing the concept.`,
    generationPrompt,
  };
}
