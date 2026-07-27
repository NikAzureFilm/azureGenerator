import assert from 'node:assert/strict';
import {
  AGENT_MAX_REFERENCE_IMAGES,
  buildAgentMessageContent,
  selectAgentImageFiles,
} from './agentAttachments.ts';

const VALID_FORMATS = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_BYTES = 10 * 1024 * 1024;

const png = (size = 1000) => ({ type: 'image/png', size });

// Accepts valid images up to the per-message cap.
{
  const { accepted, rejections } = selectAgentImageFiles({
    files: [png(), png()],
    currentCount: 0,
    maxUploadBytes: MAX_BYTES,
    validFormats: VALID_FORMATS,
  });
  assert.equal(accepted.length, 2);
  assert.deepEqual(rejections, []);
}

// Rejects unsupported formats without dropping the valid ones.
{
  const { accepted, rejections } = selectAgentImageFiles({
    files: [png(), { type: 'image/gif', size: 1000 }],
    currentCount: 0,
    maxUploadBytes: MAX_BYTES,
    validFormats: VALID_FORMATS,
  });
  assert.equal(accepted.length, 1);
  assert.deepEqual(rejections, ['format']);
}

// Rejects oversized files.
{
  const { accepted, rejections } = selectAgentImageFiles({
    files: [png(MAX_BYTES + 1)],
    currentCount: 0,
    maxUploadBytes: MAX_BYTES,
    validFormats: VALID_FORMATS,
  });
  assert.equal(accepted.length, 0);
  assert.deepEqual(rejections, ['size']);
}

// Caps the total attached per message, counting what is already attached.
{
  const { accepted, rejections } = selectAgentImageFiles({
    files: [png(), png()],
    currentCount: AGENT_MAX_REFERENCE_IMAGES - 1,
    maxUploadBytes: MAX_BYTES,
    validFormats: VALID_FORMATS,
  });
  assert.equal(accepted.length, 1);
  assert.deepEqual(rejections, ['limit']);
}

// Nothing left to accept once the cap is reached.
{
  const { accepted, rejections } = selectAgentImageFiles({
    files: [png()],
    currentCount: AGENT_MAX_REFERENCE_IMAGES,
    maxUploadBytes: MAX_BYTES,
    validFormats: VALID_FORMATS,
  });
  assert.equal(accepted.length, 0);
  assert.deepEqual(rejections, ['limit']);
}

// Content: text only, images only, both, and the empty case.
assert.deepEqual(
  buildAgentMessageContent({ text: '  a bracket  ', imageIds: [] }),
  {
    text: 'a bracket',
  },
);
assert.deepEqual(
  buildAgentMessageContent({ text: '   ', imageIds: ['img-1'] }),
  {
    images: ['img-1'],
  },
);
assert.deepEqual(
  buildAgentMessageContent({ text: 'like this', imageIds: ['img-1', 'img-2'] }),
  { text: 'like this', images: ['img-1', 'img-2'] },
);
assert.equal(buildAgentMessageContent({ text: '  ', imageIds: [] }), null);

console.log('agentAttachments tests passed');
