import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30000,
    exclude: ['**/node_modules/**', '**/.git/**', '.claude/**'],
  },
});
