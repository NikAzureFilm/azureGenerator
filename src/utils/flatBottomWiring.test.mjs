/**
 * Source-level guards for the flat-bottom option's plumbing.
 *
 * The flag has to survive four hops that no unit test can reach end to end:
 * composer -> persisted message content -> creative-chat -> mesh function, plus
 * the design-agent equivalents. Each hop is silent when it breaks (the option
 * simply stops working), so each one is pinned here.
 *
 * Run: node --experimental-strip-types src/utils/flatBottomWiring.test.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (relative) =>
  readFileSync(new URL(relative, import.meta.url), 'utf8');

const creativeChat = read('../../supabase/functions/creative-chat/index.ts');
const meshFunction = read('../../supabase/functions/mesh/index.ts');
const agentChat = read('../../supabase/functions/agent-chat/index.ts');
const agentEditor = read('../views/AgentEditorView.tsx');
const promptView = read('../views/PromptView.tsx');
const agentComposer = read('../components/AgentComposer.tsx');
const meshPreview = read('../components/viewer/MeshPreview.tsx');
const chatSection = read('../components/chat/ChatSection.tsx');
const textAreaChat = read('../components/TextAreaChat.tsx');

// --- Mesh pipeline -------------------------------------------------------

// creative-chat forwards the flag on BOTH paths that call the mesh function.
{
  assert.match(
    creativeChat,
    /isDirectMultiviewMeshRequest[\s\S]*\.\.\.\(newMessage\.content\.flatBottom && \{ flatBottom: true \}\)/,
    'the direct multiview mesh request should forward the flat-bottom flag',
  );
  assert.match(
    creativeChat,
    /const flatBottom =\s*newMessage\?\.content\?\.flatBottom === true/,
    'the create_mesh path should read the flag off the persisted user message',
  );
  assert.match(
    creativeChat,
    /meshRequestBody = \{[\s\S]*\.\.\.\(flatBottom && \{ flatBottom \}\)/,
    'the create_mesh mesh request body should carry the flag',
  );
}

// The mesh function coerces the untrusted flag, records it, and applies it to
// the concept-image prompt for every path (including ultra's no-text branches,
// which is why the directive is applied inside generateMeshImage).
{
  assert.match(
    meshFunction,
    /const flatBottom = rawFlatBottom === true;/,
    'the mesh function should coerce the flag rather than trust the body',
  );
  assert.match(
    meshFunction,
    /const prompt = applyFlatBottomImageDirective\(requestedPrompt, flatBottom\);/,
    'every concept image should get the flat-bottom art direction',
  );
  assert.match(
    meshFunction,
    /const meshTextPrompt = trimmedText\s*\?\s*appendFlatBottomPrompt\(trimmedText, flatBottom\)/,
    'the mesh text prompt should carry the flat-bottom instruction',
  );
  assert.match(
    meshFunction,
    /\.\.\.\(flatBottom && \{ flatBottom \}\),\s*\},\s*\}\)/,
    'the mesh row prompt jsonb should record the flag for the viewer/exports',
  );
}

// A missing text prompt must NOT be replaced by the bare directive: that would
// switch an image-only generation onto the concept-image path.
{
  assert.match(
    meshFunction,
    /const trimmedText = text\?\.trim\(\) \|\| undefined;/,
    'the mesh function should keep an absent text prompt absent',
  );
}

// --- Design agent --------------------------------------------------------

{
  assert.match(
    agentChat,
    /const threeDPrint = conversationSettings\.threeDPrint !== false;/,
    'the agent should default to enforcing printability for old conversations',
  );
  assert.match(
    agentChat,
    /const flatBottom = conversationSettings\.flatBottom === true;/,
    'the agent should read the flat-bottom option off the conversation',
  );
  assert.match(
    agentChat,
    /const systemPrompt = buildSystemPrompt\(\{ threeDPrint, flatBottom \}\);/,
    'the agent system prompt should be built from the print options',
  );
  assert.match(
    agentChat,
    /const generationPrompt = appendFlatBottomPrompt\(\s*toolInput\.generationPrompt,\s*flatBottom,\s*\)/,
    'recommend_pipeline should bake the requirement into the generation prompt',
  );
  assert.match(
    agentChat,
    /buildFallbackRecommendation\(\{[\s\S]*flatBottom,\s*\}\)/,
    'the prose-recommendation fallback should receive the flag too',
  );
}

// The composer renders both checkboxes, and both mount points supply them.
{
  assert.match(agentComposer, /aria-label="3D print"/);
  assert.match(agentComposer, /aria-label="Flat bottom"/);
  assert.match(
    promptView,
    /printOptions=\{agentPrintOptions\}[\s\S]*onPrintOptionsChange=\{setAgentPrintOptions\}/,
    'the first-message composer should be wired to the print options',
  );
  assert.match(
    promptView,
    /\.\.\.\(type === 'agent'\s*\?\s*\{ mode: 'agent', \.\.\.agentPrintOptions \}/,
    'the draft conversation upsert should persist the print options',
  );
  assert.match(
    agentEditor,
    /printOptions=\{printOptions\}[\s\S]*onPrintOptionsChange=\{handlePrintOptionsChange\}/,
    'the ongoing agent chat should be wired to the print options',
  );
}

// The handoff must carry the option BOTH as prose (the only channel the
// downstream prompt has) and as a structural flag (which survives the model
// rewriting the prompt text).
{
  assert.match(
    agentEditor,
    /buildAgentHandoffPrompt\(\s*recommendation\?\.generationPrompt\?\.trim\(\) \|\| lastUserText,\s*pipeline,\s*printOptions\.flatBottom,\s*\)/,
    'the handoff prompt should restate the flat-bottom requirement',
  );
  assert.match(
    agentEditor,
    /\.\.\.\(printOptions\.flatBottom \? \{ flatBottom: true \} : \{\}\)/,
    'the handoff content should carry the structural flag',
  );
  assert.match(
    agentEditor,
    /threeDPrint: printOptions\.threeDPrint,\s*flatBottom: printOptions\.flatBottom,/,
    'graduating the conversation should keep the print options in settings',
  );
}

// --- The option survives beyond the message that set it ------------------

// The choice is stored on the conversation and read back into the composer.
// Without this, the design agent's handoff (which persists settings.flatBottom
// at graduation) would be silently dropped by the composer the graduated
// conversation lands in — and for multiview, where the agent sends no message
// at all, that composer submit is the ONLY generation there is.
{
  assert.match(
    chatSection,
    /const flatBottom = conversation\.settings\?\.flatBottom === true;/,
    'the chat section should seed the composer from the conversation',
  );
  assert.match(
    chatSection,
    /flatBottom=\{flatBottom\}[\s\S]*onFlatBottomChange=\{handleFlatBottomChange\}/,
    'the composer should be handed the persisted value and a writer',
  );
  assert.match(
    chatSection,
    /handleFlatBottomChange[\s\S]*updateConversation\(\{[\s\S]*flatBottom: value,/,
    'toggling should persist onto the conversation settings',
  );
  assert.match(
    textAreaChat,
    /const flatBottom = controlledFlatBottom \?\? localFlatBottom;/,
    'the composer should prefer the parent-controlled value',
  );
  assert.match(
    promptView,
    /\.\.\.\(type === 'creative' && flatBottom \? \{ flatBottom: true \} : \{\}\)/,
    'a first mesh message should persist the option onto the new conversation',
  );
}

// --- Viewer / exports ----------------------------------------------------

// The cut is applied to the shared GLTF scene, which is what makes the
// viewport, every download and both viewer dialogs agree.
{
  assert.match(
    meshPreview,
    /'flatBottom' in meshData\.prompt/,
    'the viewer should decide from the mesh row, not from local state',
  );
  assert.match(
    meshPreview,
    /await applyFlatBottomToScene\(loaded\.gltf\.scene\)/,
    'the cut should be applied to the loaded scene before it is published',
  );
  assert.match(
    meshPreview,
    /const cut = await applyFlatBottomToScene\([\s\S]{0,80}\);\s*if \(cancelled\) return;/,
    'only a cancelled effect skips publishing — a failed or superseded cut must still show the model',
  );
}

// The main thread must never import the manifold WASM directly: it belongs to
// the worker chunk (importing it here would pull it into the main bundle).
{
  const client = read('./flatBottomClient.ts');
  const scene = read('./flatBottomScene.ts');
  for (const [name, source] of [
    ['flatBottomClient', client],
    ['flatBottomScene', scene],
    ['MeshPreview', meshPreview],
  ]) {
    assert.doesNotMatch(
      source,
      /from 'manifold-3d'|from '\.\/flatBottomCut'(?!;?\s*$)/m,
      `${name} should not pull manifold onto the main thread`,
    );
  }
  assert.match(
    client,
    /import type \{ CutMeshInput \} from '\.\/flatBottomCut'/,
    'the client should import cut types only',
  );
}

console.log('flatBottomWiring tests passed');
