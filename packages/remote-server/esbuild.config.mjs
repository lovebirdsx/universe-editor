// Bundles the remote-server entry into a single ESM file so the local editor can
// spawn it over ssh (`ssh user@host universe-editor-server`) with the host's own
// system Node, without shipping a node_modules tree. Mirrors the extension-host
// build.
//
// Workspace deps (@universe-editor/platform, node-services, extensions-common) are
// inlined by the bundle. @vscode/ripgrep and @parcel/watcher ship native binaries
// that cannot be bundled — they stay external and resolve from the host's
// node_modules (dev/e2e use the workspace's hoisted node_modules).

import { build, context } from 'esbuild'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const outFile = resolve(root, 'dist/bootstrap.js')
const watch = process.argv.includes('--watch')

const buildOptions = {
  entryPoints: [resolve(root, 'src/bootstrap.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  minify: false,
  sourcemap: true,
  logLevel: 'info',
  external: ['@vscode/ripgrep', '@parcel/watcher'],
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

// Mark the standalone bundle as ESM (dist/ is copied without the package root's
// package.json, so Node would otherwise infer CJS and reject the `import`s).
await writeFile(
  resolve(root, 'dist/package.json'),
  JSON.stringify({ type: 'module' }, null, 2) + '\n',
)

if (watch) {
  const ctx = await context(buildOptions)
  await ctx.watch()
  console.log('[remote-server] watching...')
} else {
  await build(buildOptions)
  console.log('remote-server bundled → dist/bootstrap.js')
}
