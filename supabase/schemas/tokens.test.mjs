import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const tokensSql = readFileSync(new URL('./tokens.sql', import.meta.url), 'utf8');

assert.match(tokensSql, /\('mesh', 41\)/);
assert.match(tokensSql, /\('parametric', 35\)/);
assert.match(tokensSql, /\('chat', 10\)/);
