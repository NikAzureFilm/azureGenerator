import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(
  new URL('./ImageGenerateDialog.tsx', import.meta.url),
  'utf8',
);
const textAreaChatSource = readFileSync(
  fileURLToPath(new URL('./TextAreaChat.tsx', import.meta.url)),
  'utf8',
);
const multiviewComposerSource = readFileSync(
  fileURLToPath(new URL('./MultiviewComposer.tsx', import.meta.url)),
  'utf8',
);

assert.doesNotMatch(
  source,
  /3D Object Agent/,
  'image generation dialog should not show the 3D Object Agent card',
);

assert.doesNotMatch(
  source,
  /Collapsible|CollapsibleTrigger|CollapsibleContent|Object brief is set|Optional object brief|ChevronDown/,
  'object brief should always be open without an expand brief button',
);

assert.match(
  source,
  /grid-cols-1[\s\S]*sm:grid-cols-3/,
  'image model choices should fit three Premium, Normal, and Light tiers responsively',
);

assert.match(
  source,
  /\{option\.description\}/,
  'image model choices should show their speed and quality descriptions',
);

assert.match(
  source,
  /<Textarea[\s\S]*value=\{prompt\}[\s\S]*onChange=\{\(event\) => onPromptChange\(event\.target\.value\)\}/,
  'prompt text should use only the visible prompt passed by the parent',
);

assert.match(
  textAreaChatSource,
  /const openImageCreator = useCallback\(\(\) => \{\s+setImageCreatorPrompt\(''\);[\s\S]*?setIsImageCreatorOpen\(true\);/,
  'create-input-image dialog should open with an empty visible prompt',
);

assert.match(
  textAreaChatSource,
  /options\?\.promptOverride\?\.trim\(\) \|\|\s+input\.trim\(\) \|\|\s+DEFAULT_CREATIVE_PROMPT/,
  'create-input-image generation should keep the chat prompt as the hidden fallback',
);

assert.match(
  multiviewComposerSource,
  /setDialogState\(\{\s+targetSlot: slot,\s+references: buildReferencesForSlot\(slot\),\s+prompt: '',/s,
  'multiview generate dialog should open with an empty visible prompt',
);

assert.match(
  multiviewComposerSource,
  /buildMultiviewGenerationPrompt\(\{\s+targetSlot,\s+prompt: dialogPrompt,/s,
  'multiview generation should keep its view prompt in the hidden generation prompt',
);
