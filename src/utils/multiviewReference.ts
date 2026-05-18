import type { MultiviewSlot } from '@shared/types';

export interface MultiviewReferenceSlotState {
  id?: string;
  url?: string;
  isBusy?: boolean;
}

export type MultiviewReferenceSlotMap = Partial<
  Record<MultiviewSlot, MultiviewReferenceSlotState>
>;

const SLOT_ORDER: MultiviewSlot[] = ['front', 'left', 'back', 'right'];

const VIEW_GENERATION_PROMPT: Record<MultiviewSlot, string> = {
  front: 'Generate a front view of the same object.',
  left: 'Generate a left profile of the same object.',
  back: 'Generate a back view of the same object.',
  right: 'Generate a right profile of the same object.',
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
