import type { Message } from '@shared/types';

type CreativeGenerationMessage = Pick<
  Message,
  'content' | 'created_at' | 'id' | 'role'
>;

function hasCreativeGenerationContent(content: Message['content']) {
  return (
    !!content.mesh ||
    (Array.isArray(content.images) && content.images.length > 0)
  );
}

export function getCreativeGenerationHistory<
  T extends CreativeGenerationMessage,
>(messages: T[]) {
  return messages
    .map((message, index) => ({ message, index }))
    .filter(
      ({ message }) =>
        message.role === 'assistant' &&
        hasCreativeGenerationContent(message.content),
    )
    .sort((a, b) => {
      const byDate =
        new Date(a.message.created_at).getTime() -
        new Date(b.message.created_at).getTime();

      return byDate || a.index - b.index;
    })
    .map(({ message }) => message);
}
