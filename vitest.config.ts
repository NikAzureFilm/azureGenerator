import path from 'path';
import { defineConfig } from 'vitest/config';

// Unit/component tests only. The pre-existing node-based *.test.mjs suites
// (3MF export, visual checks) keep running via their own npm scripts.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@shared': path.resolve(__dirname, './shared'),
    },
  },
  test: {
    include: ['src/**/*.spec.{ts,tsx}'],
    environment: 'jsdom',
    // Required for @testing-library/react's automatic DOM cleanup
    // between tests.
    globals: true,
  },
});
