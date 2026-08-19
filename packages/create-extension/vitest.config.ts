import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    silent: 'passed-only',
    // Template e2e specs import @universe-editor/e2e-harness, which this
    // package doesn't depend on. Template unit tests (*.test.ts) are still
    // collected and act as a living check on the templates.
    exclude: [...configDefaults.exclude, 'templates/**/e2e/**'],
  },
})
