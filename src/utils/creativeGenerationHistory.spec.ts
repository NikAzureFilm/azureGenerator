import { describe, expect, it } from 'vitest';
import type { Message } from '@shared/types';
import { getCreativeGenerationHistory } from './creativeGenerationHistory';

function message(
  id: string,
  role: Message['role'],
  created_at: string,
  content: Message['content'],
) {
  return {
    id,
    role,
    created_at,
    content,
  } as Message;
}

describe('getCreativeGenerationHistory', () => {
  it('returns assistant mesh and image generations in creation order', () => {
    const generations = getCreativeGenerationHistory([
      message('user-mesh', 'user', '2026-06-16T10:00:00.000Z', {
        mesh: { id: 'upload', fileType: 'glb' },
      }),
      message('assistant-text', 'assistant', '2026-06-16T10:01:00.000Z', {
        text: 'Thinking',
      }),
      message('assistant-image', 'assistant', '2026-06-16T10:03:00.000Z', {
        images: ['image-1'],
      }),
      message('assistant-mesh', 'assistant', '2026-06-16T10:02:00.000Z', {
        mesh: { id: 'mesh-1', fileType: 'glb' },
      }),
    ]);

    expect(generations.map((generation) => generation.id)).toEqual([
      'assistant-mesh',
      'assistant-image',
    ]);
  });
});
