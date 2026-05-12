import assert from 'node:assert/strict';
import {
  buildReferenceImageAccept,
  shouldShowGeneratedInputImageControl,
  shouldShowReferenceImageControl,
} from './inputImageControls.ts';

assert.equal(
  shouldShowGeneratedInputImageControl({
    type: 'creative',
    isMultiview: false,
    parametricSupportsVision: false,
  }),
  true,
);

assert.equal(
  shouldShowGeneratedInputImageControl({
    type: 'parametric',
    isMultiview: false,
    parametricSupportsVision: true,
  }),
  true,
);

assert.equal(
  shouldShowGeneratedInputImageControl({
    type: 'parametric',
    isMultiview: false,
    parametricSupportsVision: false,
  }),
  false,
);

assert.equal(
  shouldShowReferenceImageControl({
    type: 'creative',
    isMultiview: false,
    parametricSupportsVision: false,
  }),
  true,
);

assert.equal(
  shouldShowReferenceImageControl({
    type: 'parametric',
    isMultiview: false,
    parametricSupportsVision: false,
  }),
  false,
);

assert.equal(
  buildReferenceImageAccept({
    type: 'creative',
    imageFormats: ['image/png', 'image/webp'],
    creativeMeshExtensions: ['.glb', '.obj'],
  }),
  'image/png, image/webp, .glb, .obj',
);

assert.equal(
  buildReferenceImageAccept({
    type: 'parametric',
    imageFormats: ['image/png', 'image/webp'],
    creativeMeshExtensions: ['.glb', '.obj'],
  }),
  'image/png, image/webp, .stl',
);

assert.equal(
  shouldShowGeneratedInputImageControl({
    type: 'creative',
    isMultiview: true,
    parametricSupportsVision: true,
  }),
  false,
);
