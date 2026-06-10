// Vitest config for the markdown extension's in-process language server. Mirrors
// the esbuild alias: vscode-markdown-languageservice does `import uri from
// 'vscode-uri'` (default import), but vscode-uri's ESM entry only has named
// exports, so the language service fails to load under Node ESM. Alias vscode-uri
// to its CJS entry — Vite then synthesizes both the default and named exports.
import { createRequire } from 'node:module'
import { defineConfig } from 'vitest/config'

const require = createRequire(import.meta.url)
const vscodeUriCjs = require.resolve('vscode-uri')

export default defineConfig({
  resolve: {
    alias: {
      'vscode-uri': vscodeUriCjs,
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
    // node_modules deps are externalized by default, which bypasses the alias
    // above. Inline these two so Vite transforms them and the alias applies.
    server: {
      deps: {
        inline: ['vscode-markdown-languageservice', 'vscode-uri'],
      },
    },
  },
})
