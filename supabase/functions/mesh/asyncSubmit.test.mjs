import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

assert.doesNotMatch(
  source,
  /await\s+submitMeshJob\(/,
  'mesh function should not block the HTTP response while provider setup runs',
);

const waitUntilIndex = source.indexOf('EdgeRuntime.waitUntil(\n      submitMeshJob(');
const responseIndex = source.indexOf(
  'return new Response(JSON.stringify({ id: meshData.id, fileType })',
);

assert.notEqual(
  waitUntilIndex,
  -1,
  'mesh function should enqueue submitMeshJob with EdgeRuntime.waitUntil',
);
assert.ok(
  responseIndex > waitUntilIndex,
  'mesh function should return the mesh id after enqueueing the provider job',
);

console.log('mesh async submit tests passed');
