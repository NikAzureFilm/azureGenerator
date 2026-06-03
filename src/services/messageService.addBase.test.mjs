import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./messageService.ts', import.meta.url), 'utf8');

assert.match(
  source,
  /export function useAddBaseMutation/,
  'message service should expose an add-base mutation',
);

assert.match(
  source,
  /mutationKey:\s*\['add-base', conversation\.id\]/,
  'add-base mutation should have its own query key',
);

assert.match(
  source,
  /action:\s*'add-base'[\s\S]*meshBase[\s\S]*parentMessageId/s,
  'add-base mutation should call the mesh edge function with the existing mesh, selected base, and parent message',
);
