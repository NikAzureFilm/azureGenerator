import { describe, expect, it } from 'vitest';
import { PRINTABLE_CAD_PROMPT_SUFFIX, buildCadSubmitText } from './cadPrompt';

describe('buildCadSubmitText', () => {
  it('appends the printable instruction when enabled', () => {
    expect(buildCadSubmitText('wall hook', true)).toBe(
      `wall hook. ${PRINTABLE_CAD_PROMPT_SUFFIX}`,
    );
  });

  it('uses the printable instruction for image-only CAD submissions', () => {
    expect(buildCadSubmitText('', true)).toBe(PRINTABLE_CAD_PROMPT_SUFFIX);
  });

  it('does not duplicate an existing printable request', () => {
    expect(buildCadSubmitText('wall hook, make it 3d printable', true)).toBe(
      'wall hook, make it 3d printable',
    );
    expect(buildCadSubmitText('wall hook, make it 3D-printable', true)).toBe(
      'wall hook, make it 3D-printable',
    );
  });

  it('returns only the trimmed user prompt when disabled', () => {
    expect(buildCadSubmitText('  wall hook  ', false)).toBe('wall hook');
    expect(buildCadSubmitText('', false)).toBe('');
  });
});
