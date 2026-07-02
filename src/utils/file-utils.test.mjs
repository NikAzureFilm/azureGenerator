import assert from 'node:assert/strict';
import { isMeaningfulTitle } from './file-utils.ts';

assert.equal(isMeaningfulTitle('A Stackable Spice Rack'), true);
assert.equal(isMeaningfulTitle('New Conversation'), false);
assert.equal(isMeaningfulTitle(' New Conversation '), false);
assert.equal(isMeaningfulTitle('Untitled'), false);
assert.equal(isMeaningfulTitle(''), false);
