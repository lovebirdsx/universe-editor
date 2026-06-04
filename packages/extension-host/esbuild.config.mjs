// Bundles the extension-host entry into a single ESM file so the main process
// can spawn it via Electron's own Node runtime (ELECTRON_RUN_AS_NODE) without a
// node_modules tree in `resources/`. Mirrors vendor/claude-agent-acp's build.
//
// Workspace deps (@universe-editor/extensions-common, extension-api) are inlined
// by the bundle. The platform package is referenced for shared types/IPC only;
// it is bundled too so the host runs standalone.

import { build } from 'esbuild'
import { rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const outFile = resolve(root, 'dist/bootstrap.js')

await rm(resolve(root, 'dist'), { recursive: true, force: true })

await build({
  entryPoints: [resolve(root, 'src/bootstrap.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  minify: false,
  sourcemap: true,
  logLevel: 'info',
  // ESM bundles that use Node built-ins via bare specifiers stay external.
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
})

// Mark the standalone bundle as ESM. extraResources copies only `dist/` without
// the package root's package.json, so Node would otherwise infer CJS and reject
// the bundle's `import` statements.
await writeFile(
  resolve(root, 'dist/package.json'),
  JSON.stringify({ type: 'module' }, null, 2) + '\n',
)

console.log('extension-host bundled → dist/bootstrap.js')
