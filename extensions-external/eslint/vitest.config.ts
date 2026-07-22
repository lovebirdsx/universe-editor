import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Out-of-workspace: no local node_modules. Resolve the `vscode-*` runtime deps
// the source imports from the borrowed extension that installs them.
const borrowed = resolve(dirname(fileURLToPath(import.meta.url)), '../../extensions/typescript')
const require = createRequire(resolve(borrowed, 'package.json'))

export default defineConfig({
  test: {
    silent: 'passed-only',
    environment: 'node',
  },
  resolve: {
    alias: {
      'vscode-uri': require.resolve('vscode-uri'),
      'vscode-languageserver-types': require.resolve('vscode-languageserver-types'),
    },
  },
})
