import assert from 'node:assert/strict';
import {
  DEFAULT_CAD_BACKEND,
  getCadBackendTokenCost,
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

assert.equal(getCadBackendTokenCost('openscad', 'google/gemini-3.5-flash'), 60);
assert.equal(
  getCadBackendTokenCost('text-to-cad', 'google/gemini-3.5-flash'),
  200,
);
assert.equal(
  getCadBackendTokenCost('openscad', 'anthropic/claude-opus-4.7'),
  130,
);
assert.equal(
  getCadBackendTokenCost('text-to-cad', 'anthropic/claude-opus-4.7'),
  270,
);
