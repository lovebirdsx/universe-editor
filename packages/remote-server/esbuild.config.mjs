// Bundles the remote-server entries into standalone ESM files so the editor can
// run them on a remote host's own system Node without shipping a node_modules
// tree. Two outputs:
//   dist/        — dev/e2e build (esbuild.config.mjs) and the bundle the local
//                  editor invokes directly (`node dist/bootstrap.js serve`).
//   dist-bundle/ — self-contained deployment tree (`--bundle`): everything
//                  inlined except the native modules, plus a minimal package.json
//                  so the remote side can `npm install --omit=dev`.
//
// Workspace deps (@universe-editor/platform, node-services) are inlined.
// @vscode/ripgrep and @parcel/watcher ship native binaries that cannot be
// bundled — they stay external and resolve from node_modules.

import { build, context } from 'esbuild'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const watch = process.argv.includes('--watch')
const deploy = process.argv.includes('--bundle')

const outDir = deploy ? resolve(root, 'dist-bundle') : resolve(root, 'dist')
const entries = {
  bootstrap: resolve(root, 'src/bootstrap.ts'),
  watcherChild: resolve(root, 'src/watcherChild.ts'),
}

async function nativeDepVersion(name, fallback) {
  try {
    const raw = await readFile(resolve(root, 'node_modules', name, 'package.json'), 'utf8')
    return JSON.parse(raw).version ?? fallback
  } catch {
    return fallback
  }
}

const buildOptions = {
  entryPoints: entries,
  outdir: outDir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  minify: false,
  sourcemap: true,
  logLevel: 'info',
  external: ['@vscode/ripgrep', '@parcel/watcher', '@lydell/node-pty'],
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
}

if (watch) {
  await mkdir(outDir, { recursive: true })
} else {
  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })
}

// Mark the standalone bundle as ESM (dist/ is copied without the package root's
// package.json, so Node would otherwise infer CJS and reject the `import`s). The
// deployment tree additionally carries the server version and the native deps the
// remote side installs.
const pkg = { type: 'module' }
if (deploy) {
  pkg.version = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')).version
  pkg.dependencies = {
    '@parcel/watcher': `^${await nativeDepVersion('@parcel/watcher', '2.6.0')}`,
    '@vscode/ripgrep': `^${await nativeDepVersion('@vscode/ripgrep', '1.18.0')}`,
    // Pinned exactly: node-pty is a prebuilt beta (semver ranges are unfriendly
    // to prereleases); the remote side must resolve the same binary as the editor.
    '@lydell/node-pty': await nativeDepVersion('@lydell/node-pty', '1.2.0-beta.12'),
  }
}
await writeFile(resolve(outDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')

if (watch) {
  const ctx = await context(buildOptions)
  await ctx.watch()
  console.log(`[remote-server] watching → ${outDir}`)
} else {
  await build(buildOptions)
  console.log(`remote-server bundled → ${outDir}`)
}
