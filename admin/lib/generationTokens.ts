const PARAMETRIC_GENERATION_TOKENS = 25;

export function displayGenerationTokens(row: {
  kind: string;
  tokens_used: number | null;
}): number | null {
  if (row.kind === 'parametric') {
    return PARAMETRIC_GENERATION_TOKENS;
  }

  return row.tokens_used;
}
