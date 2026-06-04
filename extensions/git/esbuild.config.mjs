// Bundles the git extension into a single ESM file shipped under
// resources/extensions/git/dist. `@universe-editor/extension-api` is bundled in:
// its runtime is a thin shim that delegates to the host bridge installed on
// globalThis, so the extension carries no API implementation of its own.

import { build } from 'esbuild'
import { rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const outFile = resolve(root, 'dist/extension.js')

await rm(resolve(root, 'dist'), { recursive: true, force: true })

await build({
  entryPoints: [resolve(root, 'src/extension.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  minify: false,
  sourcemap: true,
  logLevel: 'info',
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
})

await writeFile(
  resolve(root, 'dist/package.json'),
  JSON.stringify({ type: 'module' }, null, 2) + '\n',
)

console.log('git extension bundled → dist/extension.js')
