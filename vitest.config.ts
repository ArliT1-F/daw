import { defineConfig } from 'vitest/config';

// Browser acceptance tests are run by Playwright, never by Vitest's *.spec.ts discovery.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    clearMocks: true,
  },
});
