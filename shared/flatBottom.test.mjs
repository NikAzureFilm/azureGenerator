import assert from 'node:assert/strict';

import {
  FLAT_BOTTOM_IMAGE_DIRECTIVE,
  FLAT_BOTTOM_PROMPT_SUFFIX,
  appendFlatBottomPrompt,
  applyFlatBottomImageDirective,
} from './flatBottom.ts';

// Option off: the prompt is returned trimmed but otherwise untouched.
{
  assert.equal(appendFlatBottomPrompt('  a pike fish  ', false), 'a pike fish');
  assert.equal(appendFlatBottomPrompt('a pike fish', undefined), 'a pike fish');
}

// Option on: the suffix is appended as its own sentence.
{
  const result = appendFlatBottomPrompt('a pike fish', true);
  assert.equal(result, `a pike fish. ${FLAT_BOTTOM_PROMPT_SUFFIX}`);
}

// Empty prompt with the option on degrades to the suffix alone.
{
  assert.equal(appendFlatBottomPrompt('', true), FLAT_BOTTOM_PROMPT_SUFFIX);
  assert.equal(
    appendFlatBottomPrompt(undefined, true),
    FLAT_BOTTOM_PROMPT_SUFFIX,
  );
}

// Idempotent: re-appending never stacks a second copy.
{
  const once = appendFlatBottomPrompt('a pike fish', true);
  assert.equal(appendFlatBottomPrompt(once, true), once);
}

// A prompt that already asks for a flat bottom is left alone, in the several
// phrasings a user might type.
{
  for (const prompt of [
    'a pike fish with a flat bottom',
    'a pike fish with a flat base',
    'FLAT-BOTTOMED pike fish',
    'a vase with a flat underside',
  ]) {
    assert.equal(
      appendFlatBottomPrompt(prompt, true),
      prompt,
      `should not append to: ${prompt}`,
    );
  }
}

// A prompt mentioning something else flat still gets the directive.
{
  const result = appendFlatBottomPrompt('a flat lay of coins', true);
  assert.ok(result.endsWith(FLAT_BOTTOM_PROMPT_SUFFIX));
}

// Image directive: prefixed only when enabled, and only once.
{
  assert.equal(applyFlatBottomImageDirective('render X', false), 'render X');
  const once = applyFlatBottomImageDirective('render X', true);
  assert.ok(once.startsWith(FLAT_BOTTOM_IMAGE_DIRECTIVE));
  assert.ok(once.endsWith('render X'));
  assert.equal(applyFlatBottomImageDirective(once, true), once);
}

// The image directive must not reintroduce shadow language, which
// _shared/imagePrompt.test.mjs forbids in the 3D-object enforcement block.
{
  assert.doesNotMatch(FLAT_BOTTOM_IMAGE_DIRECTIVE, /shadow/i);
  assert.doesNotMatch(FLAT_BOTTOM_PROMPT_SUFFIX, /shadow/i);
}

// The wording must never collide with the removed "mesh base" feature, whose
// regression guards match on that substring.
{
  for (const text of [FLAT_BOTTOM_IMAGE_DIRECTIVE, FLAT_BOTTOM_PROMPT_SUFFIX]) {
    assert.doesNotMatch(text, /meshBase/);
    assert.match(text, /flat/i);
  }
}

console.log('flatBottom tests passed');
