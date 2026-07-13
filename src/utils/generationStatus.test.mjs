import assert from 'node:assert/strict';
import {
  isAssistantGenerationInFlight,
  shouldPollMessagesForGeneration,
} from './generationStatus.ts';

const now = Date.parse('2026-06-15T09:00:00.000Z');

const assistantMessage = (content, createdAt = '2026-06-15T08:59:00.000Z') => ({
  role: 'assistant',
  content,
  created_at: createdAt,
});

assert.equal(
  isAssistantGenerationInFlight(assistantMessage({ model: 'ultra' }), now),
  true,
  'a recent empty assistant message should restore the loading state after refresh',
);

assert.equal(
  isAssistantGenerationInFlight(
    assistantMessage({ model: 'ultra' }, '2026-06-15T05:30:00.000Z'),
    now,
  ),
  false,
  'old empty assistant messages should not look active forever',
);

assert.equal(
  isAssistantGenerationInFlight(
    assistantMessage({
      text: 'Starting the mesh.',
      toolCalls: [{ name: 'create_mesh', status: 'pending' }],
    }),
    now,
  ),
  true,
  'pending tool calls should restore the loading state',
);

assert.equal(
  isAssistantGenerationInFlight(
    assistantMessage(
      {
        text: 'Starting the mesh.',
        toolCalls: [{ name: 'create_mesh', status: 'pending' }],
      },
      '2026-06-15T08:40:00.000Z',
    ),
    now,
  ),
  false,
  'stale pending tool calls should not keep the UI loading forever',
);

assert.equal(
  isAssistantGenerationInFlight(
    assistantMessage(
      {
        cadJob: {
          id: 'cad-job-1',
          status: 'pending',
          backend: 'text-to-cad',
        },
      },
      '2026-06-15T05:30:00.000Z',
    ),
    now,
  ),
  true,
  'an explicitly pending worker CAD job should remain active',
);

assert.equal(
  isAssistantGenerationInFlight(
    assistantMessage({
      text: 'Starting the mesh.',
      toolCalls: [{ name: 'create_mesh', status: 'error' }],
    }),
    now,
  ),
  false,
  'failed tool calls should not keep the UI in loading state',
);

assert.equal(
  isAssistantGenerationInFlight(
    assistantMessage({
      text: 'Here is the mesh.',
      mesh: { id: 'mesh-1', fileType: 'glb' },
    }),
    now,
  ),
  false,
  'messages with a mesh should let the mesh preview own pending/completed status',
);

assert.equal(
  isAssistantGenerationInFlight(
    {
      role: 'user',
      content: { text: 'Make a Pikachu.' },
      created_at: '2026-06-15T08:59:00.000Z',
    },
    now,
  ),
  false,
  'user messages are not assistant generation state',
);

assert.equal(
  shouldPollMessagesForGeneration(
    [
      {
        role: 'user',
        content: { text: 'Make a Pikachu.' },
        created_at: '2026-06-15T08:58:00.000Z',
      },
      assistantMessage({ model: 'ultra' }),
    ],
    now,
  ),
  true,
  'message polling should stay active while restored generation state exists',
);

console.log('generation status tests passed');
