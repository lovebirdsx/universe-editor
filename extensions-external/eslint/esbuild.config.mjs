/*
 * Build for the standalone ESLint extension. This extension lives OUTSIDE the
 * pnpm workspace (it ships as a `.vsix`), so it has no local `node_modules`:
 * we borrow esbuild + the `vscode-*` runtime deps from a workspace extension
 * that already installs them (`extensions/typescript`), and alias
 * `@universe-editor/extension-api` to its built `dist`.
 *
 * Two bundles come out of here:
 *   - dist/extension.js — the client, runs inside the extension host
 *   - dist/server.js    — the standalone ESLint language server, spawned by the
 *                         client through Electron-as-node
 * Both are ESM + node, sharing a banner so `require` works for the runtime
 * resolution of the workspace's own eslint (which stays `external`).
 */
import { createRequire } from 'node:module'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(root, '../..')
// Out-of-workspace: borrow esbuild (and, via nodePaths below, the bundled
// vscode-* deps) from a workspace extension that depends on them.
const borrowRoot = resolve(repoRoot, 'extensions/typescript')
const require = createRequire(resolve(borrowRoot, 'package.json'))
const { build, context } = await import(pathToFileURL(require.resolve('esbuild')).href)

const watch = process.argv.includes('--watch')
const apiEntry = resolve(repoRoot, 'packages/extension-api/dist/index.js')

const banner = {
  js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
}

/** @type {import('esbuild').BuildOptions} */
const shared = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  minify: false,
  sourcemap: true,
  logLevel: 'info',
  banner,
  alias: { '@universe-editor/extension-api': apiEntry },
  // vscode-jsonrpc / vscode-languageserver-types / vscode-uri get bundled into
  // the output; resolve them from the borrowed extension's node_modules.
  nodePaths: [resolve(borrowRoot, 'node_modules')],
  // The server resolves the *workspace's* eslint at runtime via a plain require
  // from the linted file's directory — it must never be bundled into the server.
  external: ['eslint'],
}

const entries = [
  { in: resolve(root, 'src/extension.ts'), out: resolve(root, 'dist/extension.js') },
  { in: resolve(root, 'src/server.ts'), out: resolve(root, 'dist/server.js') },
]

if (watch) {
  await mkdir(resolve(root, 'dist'), { recursive: true })
} else {
  await rm(resolve(root, 'dist'), { recursive: true, force: true })
  await mkdir(resolve(root, 'dist'), { recursive: true })
}

await writeFile(
  resolve(root, 'dist/package.json'),
  JSON.stringify({ type: 'module' }, null, 2) + '\n',
)

if (watch) {
  for (const e of entries) {
    const ctx = await context({ ...shared, entryPoints: [e.in], outfile: e.out })
    await ctx.watch()
  }
  console.log('[universe-eslint] watching...')
} else {
  for (const e of entries) {
    await build({ ...shared, entryPoints: [e.in], outfile: e.out })
  }
  console.log('universe-eslint extension bundled → dist/extension.js + dist/server.js')
}
