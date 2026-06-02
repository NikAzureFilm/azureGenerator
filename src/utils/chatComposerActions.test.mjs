import assert from 'node:assert/strict';
import {
  EDIT_OUTPUT_DRAFT,
  getComposerQuickActionDraft,
  shouldShowComposerQuickActions,
} from './chatComposerActions.ts';

const assistantResult = {
  role: 'assistant',
  content: {
    text: 'Here is the generated result.',
  },
};

assert.equal(getComposerQuickActionDraft('continue'), undefined);
assert.equal(getComposerQuickActionDraft('edit-output'), EDIT_OUTPUT_DRAFT);
assert.equal(EDIT_OUTPUT_DRAFT, 'Edit the output: ');

assert.equal(
  shouldShowComposerQuickActions({
    lastMessage: assistantResult,
    isLoading: false,
    limitReached: false,
  }),
  true,
);

assert.equal(
  shouldShowComposerQuickActions({
    lastMessage: assistantResult,
    isLoading: true,
    limitReached: false,
  }),
  false,
);

assert.equal(
  shouldShowComposerQuickActions({
    lastMessage: assistantResult,
    isLoading: false,
    limitReached: true,
  }),
  false,
);

assert.equal(
  shouldShowComposerQuickActions({
    lastMessage: {
      role: 'assistant',
      content: { error: 'failed' },
    },
    isLoading: false,
    limitReached: false,
  }),
  false,
);

assert.equal(
  shouldShowComposerQuickActions({
    lastMessage: {
      role: 'user',
      content: { text: 'Build a gear.' },
    },
    isLoading: false,
    limitReached: false,
  }),
  false,
);
