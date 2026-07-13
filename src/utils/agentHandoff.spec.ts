import { describe, expect, it } from 'vitest';

import {
  buildAgentHandoffPrompt,
  SINGLE_PIECE_HANDOFF_REQUIREMENT,
} from './agentHandoff';

describe('buildAgentHandoffPrompt', () => {
  it.each(['cad', 'mesh'] as const)(
    'adds a deterministic single-piece requirement to %s handoffs',
    (pipeline) => {
      const result = buildAgentHandoffPrompt(
        'Build a headphone hook.',
        pipeline,
      );

      expect(result).toContain('Build a headphone hook.');
      expect(result).toContain(SINGLE_PIECE_HANDOFF_REQUIREMENT);
      expect(result).toContain('exactly one contiguous, connected');
      expect(result).toContain('Do not create or display separate parts');
    },
  );

  it('uses the fallback prompt and appends the requirement only once', () => {
    const once = buildAgentHandoffPrompt('  ', 'cad');
    const twice = buildAgentHandoffPrompt(once, 'cad');

    expect(once).toContain('Generate the object we designed.');
    expect(twice).toBe(once);
  });

  it('leaves multiview prompts unchanged', () => {
    expect(buildAgentHandoffPrompt('Create four views.', 'multiview')).toBe(
      'Create four views.',
    );
  });
});
