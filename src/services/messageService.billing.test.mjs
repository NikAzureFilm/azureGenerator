import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./messageService.ts', import.meta.url), 'utf8');
const sendContentStart = source.indexOf('export function useSendContentMutation');
const sendContentEnd = source.indexOf(
  'export function useUpdateMessageOptimisticMutation',
  sendContentStart,
);
const sendContentSource = source.slice(sendContentStart, sendContentEnd);

assert.ok(sendContentStart >= 0, 'send-content mutation should exist');
assert.match(
  sendContentSource,
  /const queryClient = useQueryClient\(\)/,
  'send-content should access the shared query client',
);
assert.match(
  sendContentSource,
  /onSettled:[\s\S]*invalidateQueries\(\{\s*queryKey: \['billing', 'status'\]/,
  'every completed agent, parametric, or mesh send should refresh the visible token balance',
);

console.log('message service billing refresh tests passed');
