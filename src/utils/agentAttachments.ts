import type { Content } from '@shared/types';

// Reference images the user can attach to a single design-agent message. The
// agent reads them with vision and may pass one back as baseImageId when it
// renders a concept, so a handful is plenty.
export const AGENT_MAX_REFERENCE_IMAGES = 3;

// Smallest usable reference: matches the rest of the composer surfaces, and
// keeps a tiny thumbnail from being handed off to mesh generation later.
export const AGENT_MIN_IMAGE_DIMENSION = 256;

export type AgentAttachmentRejection = 'format' | 'size' | 'limit';

export interface AgentAttachmentCandidate {
  type: string;
  size: number;
}

export interface SelectAgentImageFilesOptions<
  T extends AgentAttachmentCandidate,
> {
  files: readonly T[];
  currentCount: number;
  maxUploadBytes: number;
  validFormats: readonly string[];
  maxImages?: number;
}

/**
 * Picks the files an agent message can accept as reference images and reports
 * why the rest were dropped. Pure so the composer's rules stay testable —
 * pixel-dimension checks need the DOM and happen in the composer itself.
 */
export function selectAgentImageFiles<T extends AgentAttachmentCandidate>({
  files,
  currentCount,
  maxUploadBytes,
  validFormats,
  maxImages = AGENT_MAX_REFERENCE_IMAGES,
}: SelectAgentImageFilesOptions<T>): {
  accepted: T[];
  rejections: AgentAttachmentRejection[];
} {
  const rejections = new Set<AgentAttachmentRejection>();
  const valid: T[] = [];

  for (const file of files) {
    if (!validFormats.includes(file.type)) {
      rejections.add('format');
      continue;
    }
    if (file.size > maxUploadBytes) {
      rejections.add('size');
      continue;
    }
    valid.push(file);
  }

  const availableSlots = Math.max(0, maxImages - currentCount);
  const accepted = valid.slice(0, availableSlots);
  if (accepted.length < valid.length) {
    rejections.add('limit');
  }

  return { accepted, rejections: [...rejections] };
}

/**
 * Builds the Content for an agent turn, or null when there is nothing to send.
 * Text-only, image-only, and text+image submissions are all valid.
 */
export function buildAgentMessageContent({
  text,
  imageIds,
}: {
  text: string;
  imageIds: readonly string[];
}): Content | null {
  const trimmed = text.trim();
  if (!trimmed && imageIds.length === 0) {
    return null;
  }
  return {
    ...(trimmed ? { text: trimmed } : {}),
    ...(imageIds.length > 0 ? { images: [...imageIds] } : {}),
  };
}
