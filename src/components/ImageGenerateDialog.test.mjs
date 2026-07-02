import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(
  new URL('./ImageGenerateDialog.tsx', import.meta.url),
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
  'image model choices should fit three Premium, Normal, and Lite tiers responsively',
);

assert.match(
  source,
  /\{option\.description\}/,
  'image model choices should show their speed and quality descriptions',
);

assert.match(
  source,
  /<Textarea[\s\S]*value=\{prompt\}[\s\S]*onChange=\{\(event\) => onPromptChange\(event\.target\.value\)\}/,
  'prompt text should stay in the always-visible input field',
);
