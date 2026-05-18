import assert from 'node:assert/strict';
import {
  buildMultiviewGenerationPrompt,
  getMultiviewGenerationReferenceIds,
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
  'Generate a left profile of the same object.',
);

assert.equal(
  buildMultiviewGenerationPrompt({
    targetSlot: 'left',
    prompt: 'orange dragon with teal wings',
  }),
  'orange dragon with teal wings Generate a left profile of the same object.',
);
