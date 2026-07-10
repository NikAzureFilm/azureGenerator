import { describe, expect, it } from 'vitest';
import { normalizeViteEnv } from './viteEnv';

describe('normalizeViteEnv', () => {
  it('removes whitespace and real trailing newlines', () => {
    expect(normalizeViteEnv('  value\r\n')).toBe('value');
  });

  it('removes escaped trailing newline sequences', () => {
    expect(normalizeViteEnv(String.raw`value\n`)).toBe('value');
    expect(normalizeViteEnv(String.raw`value\r\n`)).toBe('value');
    expect(normalizeViteEnv(String.raw`value\n\n`)).toBe('value');
  });

  it('returns undefined for missing or empty values', () => {
    expect(normalizeViteEnv(undefined)).toBeUndefined();
    expect(normalizeViteEnv('  ')).toBeUndefined();
  });
});
