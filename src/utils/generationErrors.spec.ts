import { describe, expect, it } from 'vitest';
import { describeGenerationError } from './generationErrors';

describe('describeGenerationError', () => {
  it('maps known error codes to friendly copy', () => {
    expect(describeGenerationError('billing_unavailable')).toMatch(
      /no tokens were spent/,
    );
    expect(describeGenerationError('rate_limited')).toMatch(/too quickly/);
  });

  it('recognizes timeout messages from the worker', () => {
    expect(describeGenerationError('timeout after 120s')).toMatch(/timed out/);
    expect(describeGenerationError('Request timed out')).toMatch(/timed out/);
  });

  it('recognizes unconfigured backend errors', () => {
    expect(
      describeGenerationError('TEXT_TO_CAD_WORKER_URL is not configured.'),
    ).toMatch(/not available/);
  });

  it('falls back to generic copy for unknown errors', () => {
    expect(describeGenerationError('SomeStrangeInternalThing')).toBe(
      'We ran into some trouble with your prompt.',
    );
  });
});
