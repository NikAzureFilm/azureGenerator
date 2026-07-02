import type { MultiviewImages, MultiviewSlot } from '@shared/types';

export interface MultiviewReferenceSlotState {
  id?: string;
  url?: string;
  isBusy?: boolean;
  isQueued?: boolean;
  kind?: 'upload' | 'generated';
}

export type MultiviewReferenceSlotMap = Partial<
  Record<MultiviewSlot, MultiviewReferenceSlotState>
>;

export const MULTIVIEW_SLOT_ORDER: MultiviewSlot[] = [
  'front',
  'back',
  'left',
  'right',
];

const VIEW_GENERATION_PROMPT: Record<MultiviewSlot, string> = {
  front: 'Generate a front view of this 3D object.',
  left: 'Generate a left-side profile view of this 3D object.',
  back: 'Generate a back view of this 3D object.',
  right: 'Generate a right-side profile view of this 3D object.',
};

// The reference chain: Front anchors everything. Back is generated from
// Front; the side views are generated from Front + Back. Front itself is
// generated from the prompt alone.
const REFERENCE_CHAIN: Record<MultiviewSlot, MultiviewSlot[]> = {
  front: [],
  back: ['front'],
  left: ['front', 'back'],
  right: ['front', 'back'],
};

export function getMultiviewReferenceChainSlots(
  targetSlot: MultiviewSlot,
): MultiviewSlot[] {
  return REFERENCE_CHAIN[targetSlot];
}

export function getMultiviewGenerationReferenceIds({
  slots,
  targetSlot,
}: {
  slots: MultiviewReferenceSlotMap;
  targetSlot: MultiviewSlot;
}): string[] {
  return REFERENCE_CHAIN[targetSlot].flatMap((slot) => {
    const state = slots[slot];
    return state?.id && !state.isBusy ? [state.id] : [];
  });
}

export type MultiviewGenerationStage = MultiviewSlot[];

// Stages for "Generate all": only idle, empty slots are staged, so the
// pipeline never overwrites an existing view and cannot be double-fired
// while slots are queued or generating.
export function buildMultiviewGenerationStages(
  slots: MultiviewReferenceSlotMap,
): MultiviewGenerationStage[] {
  const stageable = (slot: MultiviewSlot) => {
    const state = slots[slot];
    return !state?.id && !state?.isBusy && !state?.isQueued;
  };
  const stages: MultiviewGenerationStage[] = [];
  if (stageable('front')) stages.push(['front']);
  if (stageable('back')) stages.push(['back']);
  const sides = (['left', 'right'] as MultiviewSlot[]).filter(stageable);
  if (sides.length > 0) stages.push(sides);
  return stages;
}

export function markMultiviewStagesQueued({
  slots,
  stages,
}: {
  slots: MultiviewReferenceSlotMap;
  stages: MultiviewGenerationStage[];
}): MultiviewReferenceSlotMap {
  const next: MultiviewReferenceSlotMap = { ...slots };
  for (const slot of stages.flat()) {
    next[slot] = { ...next[slot], isQueued: true };
  }
  return next;
}

export function clearQueuedMultiviewSlots(
  slots: MultiviewReferenceSlotMap,
): MultiviewReferenceSlotMap {
  const next: MultiviewReferenceSlotMap = { ...slots };
  for (const slot of MULTIVIEW_SLOT_ORDER) {
    const state = next[slot];
    if (!state?.isQueued) continue;
    if (state.id || state.url || state.isBusy) {
      next[slot] = { ...state, isQueued: false };
    } else {
      delete next[slot];
    }
  }
  return next;
}

export function getMultiviewImageEntries(
  multiviewImages?: MultiviewImages,
): Array<{ slot: MultiviewSlot; id: string }> {
  if (!multiviewImages) return [];

  return MULTIVIEW_SLOT_ORDER.flatMap((slot) => {
    const id = multiviewImages[slot];
    return typeof id === 'string' && id.length > 0 ? [{ slot, id }] : [];
  });
}

export function buildHydratedMultiviewSlots({
  multiviewImages,
  imageUrls,
}: {
  multiviewImages?: MultiviewImages;
  imageUrls: Array<{ id: string; url: string }>;
}): MultiviewReferenceSlotMap {
  const urlById = new Map(imageUrls.map(({ id, url }) => [id, url]));
  const slots: MultiviewReferenceSlotMap = {};

  for (const { slot, id } of getMultiviewImageEntries(multiviewImages)) {
    const url = urlById.get(id);
    if (!url) continue;
    slots[slot] = { id, url, kind: 'upload' };
  }

  return slots;
}

export function multiviewSlotMapsMatchPreviews(
  left: MultiviewReferenceSlotMap,
  right: MultiviewReferenceSlotMap,
): boolean {
  return MULTIVIEW_SLOT_ORDER.every((slot) => {
    const leftSlot = left[slot];
    const rightSlot = right[slot];

    return (
      leftSlot?.id === rightSlot?.id &&
      leftSlot?.url === rightSlot?.url &&
      !!leftSlot?.isBusy === !!rightSlot?.isBusy &&
      !!leftSlot?.isQueued === !!rightSlot?.isQueued &&
      leftSlot?.kind === rightSlot?.kind
    );
  });
}
export function buildMultiviewGenerationPrompt({
  targetSlot,
  prompt,
}: {
  targetSlot: MultiviewSlot;
  prompt?: string;
}): string {
  return [prompt?.trim(), VIEW_GENERATION_PROMPT[targetSlot]]
    .filter(Boolean)
    .join(' ');
}

export function getMultiviewGenerationMode(): 'multiview' {
  return 'multiview';
}

export function hasMultiviewSlotPreview(
  state?: MultiviewReferenceSlotState,
): boolean {
  return !!state?.url;
}

export function markMultiviewSlotBusy({
  slots,
  targetSlot,
  kind,
}: {
  slots: MultiviewReferenceSlotMap;
  targetSlot: MultiviewSlot;
  kind: NonNullable<MultiviewReferenceSlotState['kind']>;
}): MultiviewReferenceSlotMap {
  const previousSlot = slots[targetSlot];
  return {
    ...slots,
    [targetSlot]: {
      ...previousSlot,
      isBusy: true,
      isQueued: false,
      kind: previousSlot?.kind ?? kind,
    },
  };
}

export function restoreMultiviewSlotAfterFailure({
  slots,
  targetSlot,
  previousSlot,
}: {
  slots: MultiviewReferenceSlotMap;
  targetSlot: MultiviewSlot;
  previousSlot?: MultiviewReferenceSlotState;
}): MultiviewReferenceSlotMap {
  const nextSlots: MultiviewReferenceSlotMap = { ...slots };
  if (previousSlot) {
    nextSlots[targetSlot] = { ...previousSlot };
  } else {
    delete nextSlots[targetSlot];
  }
  return nextSlots;
}

export function getMultiviewGenerationReference({
  slots,
  sourceReferenceId,
}: {
  slots: MultiviewReferenceSlotMap;
  sourceReferenceId?: string;
}): string | undefined {
  const firstFilledSlot = MULTIVIEW_SLOT_ORDER.find((slot) => {
    const state = slots[slot];
    return !!state?.id && !state.isBusy;
  });

  return firstFilledSlot ? slots[firstFilledSlot]?.id : sourceReferenceId;
}
