import assert from 'node:assert/strict';
import { AVATAR_FALLBACK_CLASSNAME } from './avatarFallbackStyles.ts';

const classes = AVATAR_FALLBACK_CLASSNAME.split(/\s+/);

assert.ok(classes.includes('grid'));
assert.ok(classes.includes('place-items-center'));
assert.ok(classes.includes('text-sm'));
assert.ok(classes.includes('leading-none'));
