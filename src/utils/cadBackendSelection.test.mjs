import assert from 'node:assert/strict';
import {
  DEFAULT_CAD_BACKEND,
  getComposerCadBackendHint,
} from './cadBackendSelection.ts';

assert.equal(DEFAULT_CAD_BACKEND, 'openscad');

assert.equal(
  getComposerCadBackendHint({
    role: 'user',
    content: { cadBackend: 'text-to-cad' },
  }),
  'text-to-cad',
);

assert.equal(
  getComposerCadBackendHint({
    role: 'assistant',
    content: { cadBackend: 'text-to-cad' },
  }),
  'text-to-cad',
);

assert.equal(
  getComposerCadBackendHint({
    role: 'user',
    content: { cadBackend: 'openscad' },
  }),
  'openscad',
);

assert.equal(
  getComposerCadBackendHint({
    role: 'assistant',
    content: { text: 'Generated model is ready.' },
  }),
  undefined,
);
