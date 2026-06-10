import { defineConfig } from 'vitest/config'

export default defineConfig({
  // These suites shell out to the real `git` CLI; spawning many processes is slow
  // on Windows, so the 5s default times out intermittently.
  test: {
    testTimeout: 30000,
    hookTimeout: 30000,
  },
})
