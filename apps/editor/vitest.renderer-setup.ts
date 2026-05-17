import { afterEach, beforeAll } from 'vitest'
import { cleanup } from '@testing-library/react'
import { MonacoLoader } from './src/renderer/workbench/editor/monaco/MonacoLoader.js'

// Pre-warm the lazy monaco loader so MonacoLoader.get() works in sync test
// paths. Resolves against the monaco-editor stub configured in vitest.config.ts.
beforeAll(async () => {
  await MonacoLoader.ensureInitialized()
})

afterEach(() => {
  cleanup()
})
