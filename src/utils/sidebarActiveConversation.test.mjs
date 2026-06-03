import assert from 'node:assert/strict';
import { getActiveSidebarConversationId } from './sidebarActiveConversation.ts';

assert.equal(
  getActiveSidebarConversationId(
    '/editor/456f9a60-46a0-409d-8044-ffec00931cfc',
  ),
  '456f9a60-46a0-409d-8044-ffec00931cfc',
);

assert.equal(
  getActiveSidebarConversationId(
    '/editor/456f9a60-46a0-409d-8044-ffec00931cfc/',
  ),
  '456f9a60-46a0-409d-8044-ffec00931cfc',
);

assert.equal(
  getActiveSidebarConversationId(
    '/editor/456f9a60-46a0-409d-8044-ffec00931cfc?view=mesh',
  ),
  '456f9a60-46a0-409d-8044-ffec00931cfc',
);

assert.equal(getActiveSidebarConversationId('/history'), undefined);
assert.equal(getActiveSidebarConversationId('/'), undefined);
