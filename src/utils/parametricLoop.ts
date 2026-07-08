import type { QueryClient } from '@tanstack/react-query';
import type { Message } from '@shared/types';
import { getSupabaseFunctionUrl, supabase } from '@/lib/supabase';
import { compileScadToStl } from '@/utils/compileScadToStl';
import { renderInspectionSheet } from '@/utils/renderInspectionSheet';
import { consumeMessageStream } from '@/services/messageStream';
import {
  isDrivableLoopMessage,
  nextLoopAction,
} from '@/utils/parametricLoopDecision';

type ContinuationResult =
  | { type: 'compile_error'; error: string }
  | { type: 'compile_ok' }
  | { type: 'inspection'; imagePath: string };

// One active driver per assistant message id. Guards against the
// stream-complete hook and the resume-on-open effect both trying to drive the
// same message concurrently.
const activeLoops = new Set<string>();

export function isLoopActive(messageId: string): boolean {
  return activeLoops.has(messageId);
}

// When the client decides the loop is done for a purely CLIENT-side reason
// (clean lite compile with no inspection left, repairs exhausted, a render /
// upload failure), the server never sees a final continuation, so the message's
// content.loop mirror can rest on a non-terminal status. Flip only that mirror
// to 'final' for the UI — this is display state; the authoritative loop state
// lives server-side in parametric_loop_state.
//
// Critically, re-read the FRESH row and patch ONLY content.loop, so we never
// write back a stale content snapshot that could clobber an artifact the server
// wrote concurrently.
async function finalizeLoopMirror(
  messageId: string,
  conversationId: string,
  queryClient: QueryClient,
  // When false, only sync the cache to the fresh row — do NOT patch a
  // still-non-terminal mirror to final (used when another tab actively owns the
  // round, so its live work stays visible).
  patchIfNonTerminal = true,
): Promise<void> {
  const { data } = await supabase
    .from('messages')
    .select('*')
    .eq('id', messageId)
    .eq('conversation_id', conversationId)
    .maybeSingle();
  const fresh = data as Message | null;
  if (!fresh) return;

  const loop = fresh.content.loop;
  const isTerminal =
    !loop || loop.status === 'final' || loop.status === 'failed';
  const shouldPatch = !isTerminal && patchIfNonTerminal;
  // Always sync the cache to the fresh row so a stale non-terminal mirror in the
  // cache can't keep a spinner rendering; additionally patch to terminal when
  // the fresh row itself is still non-terminal AND we're allowed to.
  const nextMessage: Message = shouldPatch
    ? {
        ...fresh,
        content: { ...fresh.content, loop: { ...loop!, status: 'final' } },
      }
    : fresh;
  queryClient.setQueryData(
    ['messages', conversationId],
    (oldMessages: Message[] | undefined) =>
      oldMessages?.map((msg) => (msg.id === messageId ? nextMessage : msg)) ??
      oldMessages,
  );
  if (!shouldPatch) return;
  try {
    await supabase
      .from('messages')
      .update({ content: nextMessage.content })
      .eq('id', messageId)
      .eq('conversation_id', conversationId);
  } catch (error) {
    console.error('[parametric-loop] finalize mirror failed', error);
  }
}

async function postContinuation(body: {
  continuation: {
    conversationId: string;
    assistantMessageId: string;
    round: number;
    result: ContinuationResult;
  };
}): Promise<Response> {
  const token = (await supabase.auth.getSession()).data.session?.access_token;
  return fetch(getSupabaseFunctionUrl('parametric-chat'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

// Ask the server to close the loop authoritatively (compile_ok on a clean
// compile, or a repairs-exhausted compile_error) instead of only patching the
// local mirror. Retries once on a network error. Returns true once the server
// has responded (it now owns the terminal state — no local finalize needed);
// false only if the server was unreachable after the retry, so the caller can
// fall back to the bounded local mirror patch.
async function closeLoopViaServer(
  result: ContinuationResult,
  messageId: string,
  round: number,
  conversationId: string,
  queryClient: QueryClient,
): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let response: Response;
    try {
      response = await postContinuation({
        continuation: {
          conversationId,
          assistantMessageId: messageId,
          round,
          result,
        },
      });
    } catch (error) {
      console.error('[parametric-loop] close request failed', error);
      continue; // network error — retry once
    }
    if (
      response.ok &&
      !response.headers.get('Content-Type')?.includes('application/json')
    ) {
      // Server finalized and streamed the terminal state into the cache.
      await consumeMessageStream({ response, queryClient, conversationId });
    } else {
      // The server REFUSED the close (409 loop_busy / round_mismatch /
      // not_awaiting_client / no_loop, or an unexpected JSON 200). Reconcile by
      // re-fetching the authoritative row into the cache so the spinner never
      // wedges. EXCEPT loop_busy: another tab/worker actively owns the round, so
      // sync but keep its live (non-terminal) work visible — don't force final.
      let reason: string | undefined;
      try {
        reason = (await response.json())?.error;
      } catch {
        // Non-JSON body — fall through to the default (patch-to-final) path.
      }
      await finalizeLoopMirror(
        messageId,
        conversationId,
        queryClient,
        reason !== 'loop_busy',
      );
    }
    return true;
  }
  return false;
}

/**
 * Drive the agentic generation loop for an assistant message the server has
 * left in `awaiting_client`: compile the current artifact, then either request
 * a compile-error repair (both tiers) or, on premium, render + upload an
 * inspection sheet and request a visual-inspection round. Repeats until the
 * server marks the loop terminal, a cap is hit, or a hard client guard trips.
 *
 * Fire-and-forget: never throws; updates the messages cache in place through
 * the shared stream reader as each round streams back.
 */
export async function driveParametricLoop({
  message,
  queryClient,
  conversationId,
}: {
  message: Message;
  queryClient: QueryClient;
  conversationId: string;
}): Promise<void> {
  if (!isDrivableLoopMessage(message)) return;
  if (activeLoops.has(message.id)) return;
  activeLoops.add(message.id);

  try {
    const userId = (await supabase.auth.getSession()).data.session?.user.id;
    if (!userId) return;

    let current = message;
    // Hard iteration guard independent of server caps, so a
    // misbehaving/looping server can never spin the client forever.
    const hardGuard = (current.content.loop?.maxRounds ?? 6) + 4;
    // Set when the loop ends for a purely client-side reason (nothing left to
    // do, or a render/upload failure) — only then does the client finalize the
    // display mirror. Server-driven stops (rejections) leave state to the server.
    let clientStopped = false;

    for (let i = 0; i < hardGuard; i++) {
      if (!isDrivableLoopMessage(current)) break;
      const loop = current.content.loop;
      const code = current.content.artifact?.code;
      if (!loop || !code) break;

      // Compile once per round; reuse the STL for inspection.
      let stl: Blob | null = null;
      let compileError: string | null = null;
      try {
        stl = await compileScadToStl(code);
      } catch (error) {
        compileError = error instanceof Error ? error.message : String(error);
      }

      const action = nextLoopAction(current, {
        compileOk: !compileError,
        isPremium: loop.tier === 'premium',
      });

      // Close the loop server-side (retries once); only fall back to the local
      // mirror patch if the server was unreachable. `compile_ok` on a clean
      // compile; `compile_error` on a dirty one (repairs exhausted → the server
      // reject-finalizes) so a stale awaiting_client row is never left behind.
      const closeServerSide = async (): Promise<void> => {
        clientStopped = true;
        const closeResult: ContinuationResult = compileError
          ? {
              type: 'compile_error',
              error: compileError.slice(0, 4000),
            }
          : { type: 'compile_ok' };
        const closed = await closeLoopViaServer(
          closeResult,
          current.id,
          loop.round,
          conversationId,
          queryClient,
        );
        if (closed) clientStopped = false;
      };

      if (action === 'stop') {
        await closeServerSide();
        break;
      }

      let result: ContinuationResult;
      if (action === 'compile_error') {
        result = {
          type: 'compile_error',
          error: (compileError ?? 'Unknown compile error').slice(0, 4000),
        };
      } else {
        // inspection: render the sheet from the STL we just compiled and upload
        // it to the owner-scoped images bucket for the reviewer. A render/upload
        // failure here is on a CLEAN compile, so close the loop server-side
        // (compile_ok) rather than leaving the row awaiting_client — losing the
        // inspection round beats a stuck authoritative row.
        if (!stl) {
          await closeServerSide();
          break;
        }
        let sheet: Blob;
        try {
          sheet = await renderInspectionSheet(stl);
        } catch (error) {
          console.error('[parametric-loop] inspection render failed', error);
          await closeServerSide();
          break;
        }
        // Path MUST match what the server recomputes server-side; the server
        // ignores this value for trust and derives its own from the same parts.
        const imagePath = `${userId}/${conversationId}/inspection-${current.id}-r${loop.round}`;
        const { error: uploadError } = await supabase.storage
          .from('images')
          .upload(imagePath, sheet, {
            contentType: 'image/png',
            upsert: true,
          });
        if (uploadError) {
          console.error(
            '[parametric-loop] inspection upload failed',
            uploadError,
          );
          await closeServerSide();
          break;
        }
        result = { type: 'inspection', imagePath };
      }

      const response = await postContinuation({
        continuation: {
          conversationId,
          assistantMessageId: current.id,
          round: loop.round,
          result,
        },
      });
      // A non-OK response is a server-side rejection (e.g. the CAS claim lost
      // the race → 409 loop_busy, ownership/stale round). Stop driving quietly
      // and re-fetch so we pick up the authoritative state / the winner's
      // result. Do NOT finalize the mirror — the server owns terminal state.
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        queryClient.invalidateQueries({
          queryKey: ['messages', conversationId],
        });
        break;
      }
      // A plain-JSON 200 (shouldn't occur for an accepted continuation) carries
      // no stream — stop without finalizing.
      if (response.headers.get('Content-Type')?.includes('application/json')) {
        break;
      }

      const next = await consumeMessageStream({
        response,
        queryClient,
        conversationId,
      });
      if (!next) break;
      current = next;
    }

    // Only finalize the display mirror when WE decided to stop; server-driven
    // stops already carry an authoritative terminal (or a state we just
    // refetched).
    if (clientStopped) {
      await finalizeLoopMirror(current.id, conversationId, queryClient);
    }
  } catch (error) {
    console.error('[parametric-loop] driver error', error);
  } finally {
    activeLoops.delete(message.id);
  }
}
