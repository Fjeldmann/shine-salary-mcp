import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Tests must never reach the network; every fetch is injected.
    testTimeout: 15_000,
  },
});
