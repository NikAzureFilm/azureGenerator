import type { QueryClient } from '@tanstack/react-query';
import type { Message } from '@shared/types';

// Merge a streamed message snapshot into the cached message list, replacing the
// matching row by id or appending it if new.
function upsertStreamedMessage(
  queryClient: QueryClient,
  conversationId: string,
  data: Message,
) {
  queryClient.setQueryData(
    ['messages', conversationId],
    (oldMessages: Message[] | undefined) => {
      if (!oldMessages || oldMessages.length === 0) return [data];
      if (oldMessages.find((msg) => msg.id === data.id)) {
        return oldMessages.map((msg) => (msg.id === data.id ? data : msg));
      }
      return [...oldMessages, data];
    },
  );
}

/**
 * Read an NDJSON stream of assistant-message snapshots (one JSON object per
 * line) and merge each into the messages cache. Shared by the parametric /
 * creative chat mutations and the agentic loop driver so there is a single
 * reader implementation. Returns the last snapshot seen.
 */
export async function consumeMessageStream({
  response,
  queryClient,
  conversationId,
  onFirstMessage,
}: {
  response: Response;
  queryClient: QueryClient;
  conversationId: string;
  onFirstMessage?: (message: Message) => void | Promise<void>;
}): Promise<Message | null> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('No reader available');
  }

  const decoder = new TextDecoder();
  let leftover = '';
  let finalMessage: Message | null = null;
  let firstHandled = false;

  const handleLine = async (rawLine: string) => {
    const line = rawLine.trim();
    if (!line) return;
    try {
      const data: Message = JSON.parse(line);
      finalMessage = data;
      upsertStreamedMessage(queryClient, conversationId, data);
      if (!firstHandled) {
        firstHandled = true;
        await onFirstMessage?.(data);
      }
    } catch (parseError) {
      console.error('Error parsing streaming data:', parseError);
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      leftover += decoder.decode(value, { stream: true });
      const lines = leftover.split('\n');
      leftover = lines.pop() ?? '';
      for (const rawLine of lines) {
        await handleLine(rawLine);
      }
    }

    const flushRemainder = decoder.decode();
    if (flushRemainder) leftover += flushRemainder;
    if (leftover.trim()) {
      await handleLine(leftover);
    }
  } finally {
    reader.releaseLock();
  }

  return finalMessage;
}
