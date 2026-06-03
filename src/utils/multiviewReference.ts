import type { MultiviewImages, MultiviewSlot } from '@shared/types';

export interface MultiviewReferenceSlotState {
  id?: string;
  url?: string;
  isBusy?: boolean;
  kind?: 'upload' | 'generated';
}

export type MultiviewReferenceSlotMap = Partial<
  Record<MultiviewSlot, MultiviewReferenceSlotState>
>;

const SLOT_ORDER: MultiviewSlot[] = ['front', 'left', 'back', 'right'];

const VIEW_GENERATION_PROMPT: Record<MultiviewSlot, string> = {
  front: 'Generate a front view of this 3D object.',
  left: 'Generate a left-side profile view of this 3D object.',
  back: 'Generate a back view of this 3D object.',
  right: 'Generate a right-side profile view of this 3D object.',
};

export function getMultiviewGenerationReferenceIds({
  slots,
  targetSlot,
}: {
  slots: MultiviewReferenceSlotMap;
  targetSlot: MultiviewSlot;
}): string[] {
  return SLOT_ORDER.flatMap((slot) => {
    if (slot === targetSlot) return [];
    const state = slots[slot];
    return state?.id && !state.isBusy ? [state.id] : [];
  });
}

export function getMultiviewImageEntries(
  multiviewImages?: MultiviewImages,
): Array<{ slot: MultiviewSlot; id: string }> {
  if (!multiviewImages) return [];

  return SLOT_ORDER.flatMap((slot) => {
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
  return SLOT_ORDER.every((slot) => {
    const leftSlot = left[slot];
    const rightSlot = right[slot];

    return (
      leftSlot?.id === rightSlot?.id &&
      leftSlot?.url === rightSlot?.url &&
      !!leftSlot?.isBusy === !!rightSlot?.isBusy &&
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
  const firstFilledSlot = SLOT_ORDER.find((slot) => {
    const state = slots[slot];
    return !!state?.id && !state.isBusy;
  });

  return firstFilledSlot ? slots[firstFilledSlot]?.id : sourceReferenceId;
}
