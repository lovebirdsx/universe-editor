import { configDefaults, defineConfig } from 'vitest/config'

// Unit tests run in plain Node; the extension API is mocked per-test with
// vi.mock (see src/__tests__/extension.test.ts). The Playwright e2e specs
// live outside this runner's scope.
export default defineConfig({
  test: {
    environment: 'node',
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
})
