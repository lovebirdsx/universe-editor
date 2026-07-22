import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  test: {
    name: 'integration',
    silent: 'passed-only',
    environment: 'node',
    root,
    include: ['scenarios/**/*.test.ts'],
    setupFiles: ['fixtures/mockElectron.ts'],
    testTimeout: 10_000,
  },
})
