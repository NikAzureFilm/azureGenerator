import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ConversationContext } from '@/contexts/ConversationContext';
import { CurrentMessageContext } from '@/contexts/CurrentMessageContext';
import type { Conversation, Message } from '@shared/types';
import { CreativePreviewSection } from './CreativePreviewSection';

vi.mock('./ImageGallery', () => ({
  ImageGallery: ({ imageIds }: { imageIds: string[] }) => (
    <div data-testid="image-gallery">{imageIds.join(',')}</div>
  ),
}));

vi.mock('./LazyMeshPreview', () => ({
  LazyMeshPreview: ({ meshId }: { meshId: string }) => (
    <div data-testid="mesh-preview">{meshId}</div>
  ),
}));

vi.mock('@/components/ImageViewer', () => ({
  ImageViewer: ({ image }: { image: string }) => (
    <div data-testid="history-image">{image}</div>
  ),
}));

const conversation = {
  id: 'conversation-1',
  title: 'Test creation',
  type: 'creative',
  privacy: 'private',
  current_message_leaf_id: 'generation-2',
  user_id: 'user-1',
  created_at: '2026-06-16T10:00:00.000Z',
  updated_at: '2026-06-16T10:00:00.000Z',
  settings: { model: 'multiview' },
} as Conversation;

function generation(id: string, imageId: string) {
  return {
    id,
    role: 'assistant',
    created_at: '2026-06-16T10:00:00.000Z',
    conversation_id: conversation.id,
    parent_message_id: 'user-message',
    rating: 0,
    content: { images: [imageId] },
  } as Message;
}

function Harness({ messages }: { messages: Message[] }) {
  const [currentMessage, setCurrentMessage] = useState<Message | null>(
    messages[1],
  );

  return (
    <ConversationContext.Provider value={{ conversation }}>
      <CurrentMessageContext.Provider
        value={{ currentMessage, setCurrentMessage }}
      >
        <CreativePreviewSection
          isLoading={false}
          generationMessages={messages}
        />
      </CurrentMessageContext.Provider>
    </ConversationContext.Provider>
  );
}

describe('CreativePreviewSection generation history', () => {
  it('lets users select older generations from the preview panel', () => {
    const messages = [
      generation('generation-1', 'old-image'),
      generation('generation-2', 'new-image'),
    ];

    render(<Harness messages={messages} />);

    expect(screen.getByTestId('image-gallery')).toHaveTextContent('new-image');
    expect(
      screen.getByRole('button', { name: 'Open generation 2' }),
    ).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Open generation 1' }));

    expect(screen.getByTestId('image-gallery')).toHaveTextContent('old-image');
    expect(
      screen.getByRole('button', { name: 'Open generation 1' }),
    ).toHaveAttribute('aria-pressed', 'true');
  });
});
