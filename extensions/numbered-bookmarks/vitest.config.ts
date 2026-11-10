import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    silent: 'passed-only',
    environment: 'node',
    // The e2e/ suite is Playwright, not vitest.
    include: ['src/**/__tests__/**/*.test.ts'],
  },
})
