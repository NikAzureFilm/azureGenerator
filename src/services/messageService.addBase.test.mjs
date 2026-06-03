import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./messageService.ts', import.meta.url), 'utf8');

assert.doesNotMatch(
  source,
  /export function useAddBaseMutation/,
  'message service should not expose an add-base mutation',
);

assert.doesNotMatch(
  source,
  /mutationKey:\s*\['add-base', conversation\.id\]/,
  'message service should not register an add-base mutation key',
);

assert.doesNotMatch(
  source,
  /action:\s*'add-base'[\s\S]*meshBase[\s\S]*meshBaseSettings[\s\S]*parentMessageId/s,
  'message service should not call the mesh edge function with add-base settings',
);
