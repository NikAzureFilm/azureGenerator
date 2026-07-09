export const PRINTABLE_CAD_PROMPT_SUFFIX = 'make it 3d printable';

const PRINTABLE_PROMPT_PATTERN = /\b3d[-\s]?printable\b/i;

export function buildCadSubmitText(
  prompt: string,
  includePrintableInstruction: boolean,
): string {
  const trimmed = prompt.trim();
  if (!includePrintableInstruction) return trimmed;
  if (!trimmed) return PRINTABLE_CAD_PROMPT_SUFFIX;
  if (PRINTABLE_PROMPT_PATTERN.test(trimmed)) return trimmed;
  return `${trimmed}. ${PRINTABLE_CAD_PROMPT_SUFFIX}`;
}
