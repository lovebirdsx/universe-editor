/*
 * Bundles src/extension.ts → dist/extension.js. The extension API package is
 * inlined into the bundle; at run time its namespaces delegate to a bridge the
 * host installs on globalThis, so the API never needs to ship inside the VSIX.
 */
import { build, context } from 'esbuild'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const outFile = resolve(root, 'dist/extension.js')
const watch = process.argv.includes('--watch')

const buildOptions = {
  entryPoints: [resolve(root, 'src/extension.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  minify: false,
  // Inline sourcemaps + sources so `uex dev --inspect` breakpoints bind to your
  // TypeScript, not the bundle.
  sourcemap: true,
  sourcesContent: true,
  logLevel: 'info',
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
}

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
  const ctx = await context(buildOptions)
  await ctx.watch()
  console.log('[extension] watching...')
} else {
  await build(buildOptions)
  console.log('extension bundled → dist/extension.js')
}
