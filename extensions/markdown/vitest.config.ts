// Vitest config for the markdown extension's in-process language server. Mirrors
// the esbuild alias: vscode-markdown-languageservice does `import uri from
// 'vscode-uri'` (default import), but vscode-uri's ESM entry only has named
// exports, so the language service fails to load under Node ESM. Alias vscode-uri
// to its CJS entry — Vite then synthesizes both the default and named exports.
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { defineConfig } from 'vitest/config'

const require = createRequire(import.meta.url)
const vscodeUriCjs = require.resolve('vscode-uri')

// vscode-markdown-languageservice ships `//# sourceMappingURL=*.js.map` comments
// but no .map files, so Vite floods stderr trying to load each one during its
// load stage (before any transform hook runs). Intercept the load ourselves and
// drop the trailing sourcemap comment so Vite never goes looking for the file.
const stripMissingSourcemaps = {
  name: 'strip-missing-sourcemaps',
  enforce: 'pre' as const,
  async load(id: string) {
    if (!id.includes('vscode-markdown-languageservice')) return null
    const file = id.split('?')[0]!
    if (!file.endsWith('.js')) return null
    const code = await readFile(file, 'utf-8')
    if (!code.includes('//# sourceMappingURL=')) return null
    return { code: code.replace(/\n?\/\/# sourceMappingURL=.*$/m, ''), map: null }
  },
}

export default defineConfig({
  plugins: [stripMissingSourcemaps],
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
