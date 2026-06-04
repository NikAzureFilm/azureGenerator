import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./AuthProvider.tsx', import.meta.url), 'utf8');

assert.match(source, /cad-job-updates-\$\{user\.id\}/);
assert.match(source, /event:\s*'cad-job-updated'/);
assert.match(source, /queryKey:\s*\['messages',\s*payload\.conversation_id\]/);
assert.match(source, /queryKey:\s*\['conversation',\s*payload\.conversation_id\]/);

console.log('AuthProvider CAD realtime tests passed');
