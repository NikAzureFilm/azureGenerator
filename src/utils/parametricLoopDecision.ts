import type { Message } from '@shared/types';

// Client-side caps mirror the server's authoritative limits (see
// supabase/functions/parametric-chat/loop.ts). They only stop the client from
// issuing round-trips the server would reject anyway; the server still
// enforces them.
export const CLIENT_MAX_REPAIRS = 2;
export const CLIENT_MAX_INSPECTION_ROUNDS = 1;

export type LoopActionKind = 'compile_error' | 'inspection' | 'stop';

// Whether a message's persisted loop state is one the client should drive
// (or resume driving). A message with an artifact but no loop, or a terminal
// loop, is done.
export function isDrivableLoopMessage(
  message: Pick<Message, 'role' | 'content'>,
): boolean {
  const loop = message.content.loop;
  return (
    message.role === 'assistant' &&
    !!loop &&
    loop.status === 'awaiting_client' &&
    !!message.content.artifact?.code
  );
}

// Pure decision for the next continuation to request, given the message's loop
// state and the outcome of compiling its current artifact. Kept side-effect
// free so it is unit-testable in isolation from the browser-only compile /
// render / upload machinery.
export function nextLoopAction(
  message: Pick<Message, 'content'>,
  capabilities: { compileOk: boolean; isPremium: boolean },
): LoopActionKind {
  const loop = message.content.loop;
  if (!loop || loop.status !== 'awaiting_client') return 'stop';

  if (!capabilities.compileOk) {
    return loop.repairs < CLIENT_MAX_REPAIRS ? 'compile_error' : 'stop';
  }

  const maxInspectionRounds = Math.min(
    loop.maxRounds,
    CLIENT_MAX_INSPECTION_ROUNDS,
  );
  if (capabilities.isPremium && loop.round < maxInspectionRounds) {
    return 'inspection';
  }
  return 'stop';
}
