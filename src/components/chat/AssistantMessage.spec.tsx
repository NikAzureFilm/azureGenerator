import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ContextType } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { AssistantMessage } from './AssistantMessage';
import { ConversationContext } from '@/contexts/ConversationContext';
import { CurrentMessageContext } from '@/contexts/CurrentMessageContext';
import { TooltipProvider } from '@/components/ui/tooltip';
import { DEFAULT_CODE_GENERATION_MODEL } from '@shared/parametricRouting';
import type { Message } from '@shared/types';
import type { TreeNode } from '@shared/Tree';

type ConversationContextValue = ContextType<typeof ConversationContext>;

function createAssistantMessage({
  content = {
    text: 'Generating model...',
    model: DEFAULT_CODE_GENERATION_MODEL,
  },
}: {
  content?: Message['content'];
} = {}): TreeNode<Message> {
  const parent = {
    id: 'parent-message',
    conversation_id: 'conversation-1',
    parent_message_id: null,
    role: 'user',
    content: {
      text: 'a stackable spice rack',
      model: DEFAULT_CODE_GENERATION_MODEL,
    },
    created_at: '2026-06-30T00:00:00.000Z',
    rating: null,
    children: [],
    parent: null,
  } as unknown as TreeNode<Message>;

  const message = {
    id: 'assistant-message',
    conversation_id: 'conversation-1',
    parent_message_id: parent.id,
    role: 'assistant',
    content,
    created_at: '2026-06-30T00:00:01.000Z',
    rating: null,
    children: [],
    parent,
  } as unknown as TreeNode<Message>;

  parent.children = [message];

  Object.defineProperties(parent, {
    siblings: {
      get: () => [parent],
    },
  });

  Object.defineProperties(message, {
    siblings: {
      get: () => parent.children,
    },
  });

  return message;
}

describe('AssistantMessage retry controls', () => {
  it('renders retry without exposing the selected model name', () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });
    const message = createAssistantMessage();
    const conversation: ConversationContextValue['conversation'] = {
      id: 'conversation-1',
      title: 'A Stackable Spice Rack',
      type: 'parametric',
      privacy: 'private',
      current_message_leaf_id: message.id,
      user_id: 'user-1',
      created_at: '2026-06-30T00:00:00.000Z',
      updated_at: '2026-06-30T00:00:01.000Z',
      settings: null,
    };

    render(
      <QueryClientProvider client={queryClient}>
        <ConversationContext.Provider value={{ conversation }}>
          <CurrentMessageContext.Provider
            value={{ currentMessage: null, setCurrentMessage: vi.fn() }}
          >
            <TooltipProvider>
              <AssistantMessage
                message={message}
                isLoading={false}
                currentVersion={1}
                changeRating={vi.fn()}
                onRetry={vi.fn()}
              />
            </TooltipProvider>
          </CurrentMessageContext.Provider>
        </ConversationContext.Provider>
      </QueryClientProvider>,
    );

    expect(
      screen.getByRole('button', { name: 'Retry generation' }),
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain('Gemini 3.1 Pro');
  });

  it('replaces an abandoned empty generation with a retryable error', () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const message = createAssistantMessage({
      content: { model: DEFAULT_CODE_GENERATION_MODEL },
    });
    const conversation: ConversationContextValue['conversation'] = {
      id: 'conversation-1',
      title: 'A Stackable Spice Rack',
      type: 'parametric',
      privacy: 'private',
      current_message_leaf_id: message.id,
      user_id: 'user-1',
      created_at: '2026-06-30T00:00:00.000Z',
      updated_at: '2026-06-30T00:00:01.000Z',
      settings: null,
    };

    render(
      <QueryClientProvider client={queryClient}>
        <ConversationContext.Provider value={{ conversation }}>
          <CurrentMessageContext.Provider
            value={{ currentMessage: null, setCurrentMessage: vi.fn() }}
          >
            <TooltipProvider>
              <AssistantMessage
                message={message}
                isLoading={false}
                currentVersion={1}
                changeRating={vi.fn()}
                onRetry={vi.fn()}
              />
            </TooltipProvider>
          </CurrentMessageContext.Provider>
        </ConversationContext.Provider>
      </QueryClientProvider>,
    );

    expect(
      screen.getByText(
        'This generation was interrupted before a model was saved.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.queryByText('Generating model...')).toBeNull();
  });
});
