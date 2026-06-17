export const KNOWN_GENERATION_ERRORS: Record<string, string> = {
  billing_unavailable:
    'Billing is temporarily unavailable, so no tokens were spent. Please try again in a moment.',
  rate_limited:
    "You're sending requests a little too quickly. Wait a moment and try again.",
};

export function describeGenerationError(error: string): string {
  if (KNOWN_GENERATION_ERRORS[error]) return KNOWN_GENERATION_ERRORS[error];
  if (/timed out|timeout/i.test(error)) {
    return 'Generation took too long and timed out. Retrying usually works.';
  }
  if (/not configured/i.test(error)) {
    return 'This generation backend is not available right now.';
  }
  return 'We ran into some trouble with your prompt.';
}
