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
  front: 'Generate a front orthographic view of this 3D object.',
  left: 'Generate a left-side orthographic view of this 3D object.',
  back: 'Generate a back orthographic view of this 3D object.',
  right: 'Generate a right-side orthographic view of this 3D object.',
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

export function getMultiviewGenerationMode(): 'multiview' {
  return 'multiview';
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
