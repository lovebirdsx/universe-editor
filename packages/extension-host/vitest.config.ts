import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globalSetup: ['@universe-editor/temp-root/vitest-setup'],
    silent: 'passed-only',
  },
})
