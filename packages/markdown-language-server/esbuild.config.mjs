// Bundles the markdown language server into standalone ESM files so the main
// process can spawn it via Electron's own Node runtime (ELECTRON_RUN_AS_NODE)
// without a node_modules tree in `resources/`. Mirrors packages/extension-host.
//
// Two entry points:
//   - bootstrap.ts → dist/bootstrap.js : the spawned server process. Workspace
//     deps (platform, extensions-common) and later vscode-markdown-languageservice
//     + markdown-it are inlined into this single file.
//   - protocol.ts  → dist/protocol.js  : the main↔server wire contract, imported
//     by the main process (LSP client host). Kept dependency-free so importing it
//     never pulls the language service into the main bundle.
//
// `tsc --emitDeclarationOnly` runs AFTER this to drop the .d.ts files alongside.

import { build, context } from 'esbuild'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const distDir = resolve(root, 'dist')
const watch = process.argv.includes('--watch')

// vscode-markdown-languageservice does `import uri from 'vscode-uri'` (default
// import), but vscode-uri's ESM entry only has named exports, so esbuild can't
// bundle the ESM build. Force vscode-uri to its CJS entry — esbuild then
// synthesizes both the default and named exports from the CommonJS module.
const require = createRequire(import.meta.url)
const vscodeUriCjs = require.resolve('vscode-uri')

const buildOptions = {
  entryPoints: [resolve(root, 'src/bootstrap.ts'), resolve(root, 'src/protocol.ts')],
  outdir: distDir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  minify: false,
  sourcemap: true,
  logLevel: 'info',
  alias: {
    'vscode-uri': vscodeUriCjs,
  },
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
}

await rm(distDir, { recursive: true, force: true })
await mkdir(distDir, { recursive: true })

// Mark the standalone bundle as ESM. extraResources copies only `dist/` without
// the package root's package.json, so Node would otherwise infer CJS and reject
// the bundle's `import` statements.
await writeFile(resolve(distDir, 'package.json'), JSON.stringify({ type: 'module' }, null, 2) + '\n')

if (watch) {
  const ctx = await context(buildOptions)
  await ctx.watch()
  console.log('[markdown-language-server] watching...')
} else {
  await build(buildOptions)
  console.log('markdown-language-server bundled → dist/{bootstrap,protocol}.js')
}
