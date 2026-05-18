import assert from 'node:assert/strict';
import {
  buildMultiviewGenerationPrompt,
  getMultiviewGenerationMode,
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
  'Generate a left-side orthographic view of this 3D object.',
);

assert.equal(
  buildMultiviewGenerationPrompt({
    targetSlot: 'left',
    prompt: 'orange dragon with teal wings',
  }),
  'orange dragon with teal wings Generate a left-side orthographic view of this 3D object.',
);

assert.equal(getMultiviewGenerationMode(), 'multiview');
