import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Some suites shell out to the real `p4` CLI or spawn helper processes; keep a
  // generous timeout so Windows process spawning doesn't trip the 5s default.
  test: {
    testTimeout: 30000,
    hookTimeout: 30000,
  },
})
