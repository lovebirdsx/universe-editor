import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    silent: 'passed-only',
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
  },
})
