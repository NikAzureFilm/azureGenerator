export function normalizeViteEnv(
  value: string | undefined,
): string | undefined {
  const normalized = value
    ?.trim()
    .replace(/(?:\\r\\n|\\n)+$/g, '')
    .trim();

  return normalized || undefined;
}
