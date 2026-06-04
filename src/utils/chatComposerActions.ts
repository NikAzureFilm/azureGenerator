import type { Content, Message } from '@shared/types';

export type ComposerQuickAction = 'continue' | 'edit-output';

export const EDIT_OUTPUT_DRAFT = 'Edit the output: ';

type LastMessage = Pick<Message, 'role' | 'content'>;

export function getComposerQuickActionDraft(action: ComposerQuickAction) {
  if (action === 'edit-output') {
    return EDIT_OUTPUT_DRAFT;
  }
  return undefined;
}

function hasAssistantOutput(content: Content) {
  return Boolean(
    content.text?.trim() ||
      content.artifact ||
      content.mesh ||
      (content.images && content.images.length > 0),
  );
}

export function shouldShowComposerQuickActions({
  lastMessage,
  isLoading,
  limitReached,
}: {
  lastMessage?: LastMessage | null;
  isLoading: boolean;
  limitReached?: boolean;
}) {
  if (isLoading || limitReached || !lastMessage) {
    return false;
  }
  if (lastMessage.role !== 'assistant' || lastMessage.content.error) {
    return false;
  }
  return hasAssistantOutput(lastMessage.content);
}
