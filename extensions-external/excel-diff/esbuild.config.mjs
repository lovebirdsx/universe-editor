/*
 * Build for the standalone Excel viewer/diff extension. Lives OUTSIDE the pnpm
 * workspace (ships as a `.vsix`). Unlike the PDF extension it has its own
 * `node_modules` (for SheetJS), installed via `npm install` in this directory;
 * SheetJS is bundled into `dist/extension.js`. esbuild + the API alias are
 * resolved from the repo, matching the PDF extension's out-of-workspace setup.
 */
import { createRequire } from 'node:module'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(root, '../..')
// Out-of-workspace: borrow esbuild from a workspace package that depends on it.
const require = createRequire(resolve(repoRoot, 'extensions/numbered-bookmarks/package.json'))
const { build, context } = await import(pathToFileURL(require.resolve('esbuild')).href)

const watch = process.argv.includes('--watch')
const apiEntry = resolve(repoRoot, 'packages/extension-api/dist/index.js')

const buildOptions = {
  entryPoints: [resolve(root, 'src/extension.ts')],
  outfile: resolve(root, 'dist/extension.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
  loader: { '.html': 'text' },
  alias: { '@universe-editor/extension-api': apiEntry },
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
}

await rm(resolve(root, 'dist'), { recursive: true, force: true })
await mkdir(resolve(root, 'dist'), { recursive: true })

if (watch) {
  const ctx = await context(buildOptions)
  await ctx.watch()
  console.log('[universe-excel-diff] watching...')
} else {
  await build(buildOptions)
  console.log('universe-excel-diff extension bundled → dist/extension.js')
}
