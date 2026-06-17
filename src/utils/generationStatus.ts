import type { Content, Message } from '@shared/types';

const RESTORED_GENERATION_WINDOW_MS = 2 * 60 * 60 * 1000;

type GenerationMessage = Pick<Message, 'role' | 'content' | 'created_at'>;

function hasItems(value: unknown[] | undefined) {
  return Array.isArray(value) && value.length > 0;
}

function hasPendingToolCall(content: Content) {
  return content.toolCalls?.some((toolCall) => toolCall.status === 'pending');
}

function hasTerminalToolCallState(content: Content) {
  return (
    hasItems(content.toolCalls) &&
    !content.toolCalls?.some((toolCall) => toolCall.status === 'pending')
  );
}

function hasCompletedAssistantOutput(content: Content) {
  return Boolean(
    content.text?.trim() ||
    content.error ||
    content.artifact ||
    content.mesh ||
    content.cadJob?.status === 'success' ||
    content.cadJob?.status === 'failure' ||
    hasItems(content.images) ||
    hasItems(content.suggestions),
  );
}

function isRecentEnough(
  createdAt: string | null | undefined,
  currentTime: number,
) {
  if (!createdAt) return false;
  const createdTime = Date.parse(createdAt);
  if (Number.isNaN(createdTime)) return false;
  return currentTime - createdTime < RESTORED_GENERATION_WINDOW_MS;
}

export function isAssistantGenerationInFlight(
  message: GenerationMessage | null | undefined,
  currentTime = Date.now(),
) {
  if (!message || message.role !== 'assistant') {
    return false;
  }

  const { content } = message;

  if (hasPendingToolCall(content) || content.cadJob?.status === 'pending') {
    return true;
  }

  if (
    hasTerminalToolCallState(content) ||
    hasCompletedAssistantOutput(content)
  ) {
    return false;
  }

  return isRecentEnough(message.created_at, currentTime);
}

export function shouldPollMessagesForGeneration(
  messages: GenerationMessage[] | null | undefined,
  currentTime = Date.now(),
) {
  return Boolean(
    messages?.some((message) =>
      isAssistantGenerationInFlight(message, currentTime),
    ),
  );
}
