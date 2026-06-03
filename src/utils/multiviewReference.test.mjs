import assert from 'node:assert/strict';
import {
  buildMultiviewGenerationPrompt,
  getMultiviewGenerationMode,
  getMultiviewGenerationReferenceIds,
  hasMultiviewSlotPreview,
  markMultiviewSlotBusy,
  restoreMultiviewSlotAfterFailure,
} from './multiviewReference.ts';

assert.deepEqual(
  getMultiviewGenerationReferenceIds({
    targetSlot: 'left',
    slots: {
      front: { id: 'front-image-id' },
      left: { id: 'existing-left-id' },
      back: { id: 'back-image-id' },
      right: { id: 'right-image-id', isBusy: true },
    },
  }),
  ['front-image-id', 'back-image-id'],
);

assert.equal(
  buildMultiviewGenerationPrompt({
    targetSlot: 'left',
    prompt: '',
  }),
  'Generate a left-side profile view of this 3D object.',
);

assert.equal(
  buildMultiviewGenerationPrompt({
    targetSlot: 'left',
    prompt: 'orange dragon with teal wings',
  }),
  'orange dragon with teal wings Generate a left-side profile view of this 3D object.',
);

assert.equal(
  buildMultiviewGenerationPrompt({
    targetSlot: 'front',
    prompt: '',
  }),
  'Generate a front view of this 3D object.',
);

assert.equal(
  buildMultiviewGenerationPrompt({
    targetSlot: 'back',
    prompt: '',
  }),
  'Generate a back view of this 3D object.',
);

assert.equal(
  buildMultiviewGenerationPrompt({
    targetSlot: 'right',
    prompt: '',
  }),
  'Generate a right-side profile view of this 3D object.',
);

assert.equal(getMultiviewGenerationMode(), 'multiview');

assert.equal(
  hasMultiviewSlotPreview({
    id: 'front-image-id',
    url: 'https://example.com/front.png',
    isBusy: true,
  }),
  true,
  'busy multiview slots should still expose their preview image',
);

assert.deepEqual(
  markMultiviewSlotBusy({
    slots: {
      front: {
        id: 'front-image-id',
        url: 'https://example.com/front.png',
        kind: 'upload',
      },
    },
    targetSlot: 'front',
    kind: 'generated',
  }),
  {
    front: {
      id: 'front-image-id',
      url: 'https://example.com/front.png',
      isBusy: true,
      kind: 'upload',
    },
  },
  'starting generation should keep the previous image in its holder',
);

assert.deepEqual(
  markMultiviewSlotBusy({
    slots: {},
    targetSlot: 'left',
    kind: 'generated',
  }),
  {
    left: {
      isBusy: true,
      kind: 'generated',
    },
  },
  'empty generated slots should still show a busy holder',
);

assert.deepEqual(
  restoreMultiviewSlotAfterFailure({
    slots: {
      front: {
        id: 'front-image-id',
        url: 'https://example.com/front.png',
        isBusy: true,
        kind: 'upload',
      },
    },
    targetSlot: 'front',
    previousSlot: {
      id: 'front-image-id',
      url: 'https://example.com/front.png',
      kind: 'upload',
    },
  }),
  {
    front: {
      id: 'front-image-id',
      url: 'https://example.com/front.png',
      kind: 'upload',
    },
  },
  'failed regeneration should restore the previous holder image',
);

assert.deepEqual(
  restoreMultiviewSlotAfterFailure({
    slots: {
      left: {
        isBusy: true,
        kind: 'generated',
      },
    },
    targetSlot: 'left',
    previousSlot: undefined,
  }),
  {},
  'failed generation from an empty holder should clear only that busy holder',
);
