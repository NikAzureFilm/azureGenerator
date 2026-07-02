import { describe, expect, it } from 'vitest';
import {
  buildMultiviewGenerationStages,
  clearQueuedMultiviewSlots,
  getMultiviewGenerationReferenceIds,
  getMultiviewReferenceChainSlots,
  markMultiviewSlotBusy,
  markMultiviewStagesQueued,
  type MultiviewReferenceSlotMap,
} from './multiviewReference';

describe('getMultiviewGenerationReferenceIds', () => {
  const filledSlots: MultiviewReferenceSlotMap = {
    front: { id: 'front-id', url: 'front-url' },
    back: { id: 'back-id', url: 'back-url' },
    left: { id: 'left-id', url: 'left-url' },
    right: { id: 'right-id', url: 'right-url' },
  };

  it('gives front no view references', () => {
    expect(
      getMultiviewGenerationReferenceIds({
        slots: filledSlots,
        targetSlot: 'front',
      }),
    ).toEqual([]);
  });

  it('gives back only the front reference', () => {
    expect(
      getMultiviewGenerationReferenceIds({
        slots: filledSlots,
        targetSlot: 'back',
      }),
    ).toEqual(['front-id']);
  });

  it('gives the sides front + back, never the other side', () => {
    expect(
      getMultiviewGenerationReferenceIds({
        slots: filledSlots,
        targetSlot: 'left',
      }),
    ).toEqual(['front-id', 'back-id']);
    expect(
      getMultiviewGenerationReferenceIds({
        slots: filledSlots,
        targetSlot: 'right',
      }),
    ).toEqual(['front-id', 'back-id']);
  });

  it('skips busy and missing chain slots', () => {
    expect(
      getMultiviewGenerationReferenceIds({
        slots: {
          front: { id: 'front-id', url: 'front-url' },
          back: { id: 'back-id', url: 'back-url', isBusy: true },
        },
        targetSlot: 'right',
      }),
    ).toEqual(['front-id']);
  });

  it('exposes the chain slot order for labeling', () => {
    expect(getMultiviewReferenceChainSlots('left')).toEqual(['front', 'back']);
    expect(getMultiviewReferenceChainSlots('front')).toEqual([]);
  });
});

describe('buildMultiviewGenerationStages', () => {
  it('stages front, then back, then both sides for an empty board', () => {
    expect(buildMultiviewGenerationStages({})).toEqual([
      ['front'],
      ['back'],
      ['left', 'right'],
    ]);
  });

  it('skips filled slots so the pipeline is idempotent', () => {
    expect(
      buildMultiviewGenerationStages({
        front: { id: 'front-id', url: 'front-url' },
        left: { id: 'left-id', url: 'left-url' },
      }),
    ).toEqual([['back'], ['right']]);
  });

  it('skips generating and queued slots so it cannot double-fire', () => {
    expect(
      buildMultiviewGenerationStages({
        front: { isBusy: true },
        back: { isQueued: true },
        left: { isQueued: true },
        right: { isQueued: true },
      }),
    ).toEqual([]);
  });

  it('returns nothing when every slot is filled', () => {
    expect(
      buildMultiviewGenerationStages({
        front: { id: 'a' },
        back: { id: 'b' },
        left: { id: 'c' },
        right: { id: 'd' },
      }),
    ).toEqual([]);
  });
});

describe('queued slot lifecycle', () => {
  it('marks staged slots queued and clears empty ones on abort', () => {
    const stages = buildMultiviewGenerationStages({});
    const queued = markMultiviewStagesQueued({ slots: {}, stages });
    expect(queued.front?.isQueued).toBe(true);
    expect(queued.left?.isQueued).toBe(true);
    expect(queued.back?.isQueued).toBe(true);
    expect(queued.right?.isQueued).toBe(true);

    const cleared = clearQueuedMultiviewSlots(queued);
    expect(cleared).toEqual({});
  });

  it('keeps filled slots when clearing the queue', () => {
    const cleared = clearQueuedMultiviewSlots({
      front: { id: 'front-id', url: 'front-url', isQueued: true },
      back: { isQueued: true },
    });
    expect(cleared.front).toEqual({
      id: 'front-id',
      url: 'front-url',
      isQueued: false,
    });
    expect(cleared.back).toBeUndefined();
  });

  it('clears the queued flag when a slot starts generating', () => {
    const marked = markMultiviewSlotBusy({
      slots: { back: { isQueued: true } },
      targetSlot: 'back',
      kind: 'generated',
    });
    expect(marked.back).toEqual({
      isBusy: true,
      isQueued: false,
      kind: 'generated',
    });
  });
});
