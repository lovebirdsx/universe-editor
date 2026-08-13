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
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extensionPackageFiles } from '@universe-editor/extension-packaging'

const root = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(root, '../..')
const extensionsRoot = join(repoRoot, 'extensions')
const watch = process.argv.includes('--watch')
const deploy = process.argv.includes('--bundle')

const outDir = deploy ? resolve(root, 'dist-bundle') : resolve(root, 'dist')
const entries = {
  bootstrap: resolve(root, 'src/bootstrap.ts'),
  watcherChild: resolve(root, 'src/watcherChild.ts'),
  // The extension-host bootstrap is re-bundled (same technique as bootstrap.js)
  // so the daemon can fork it on the remote host without shipping that package's
  // node_modules. Pure-JS deps (extension-api/extensions-common/platform/zod) are
  // inlined; no native deps, so nothing extra goes into dist-bundle/package.json.
  'extension-host/bootstrap': resolve(root, '../extension-host/src/bootstrap.ts'),
}

async function nativeDepVersion(name, fallback) {
  try {
    const raw = await readFile(resolve(root, 'node_modules', name, 'package.json'), 'utf8')
    return JSON.parse(raw).version ?? fallback
  } catch {
    return fallback
  }
}

/** Version of a vendored TS language-service package (same tree the editor ships). */
async function vendoredVersion(name, fallback) {
  try {
    const raw = await readFile(
      resolve(repoRoot, 'vendor/typescript-language-server/node_modules', name, 'package.json'),
      'utf8',
    )
    return JSON.parse(raw).version ?? fallback
  } catch {
    return fallback
  }
}

/** Directories under `extensions/` that carry a manifest (the built-in set). */
function builtinExtensionDirs() {
  if (!existsSync(extensionsRoot)) return []
  return readdirSync(extensionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(extensionsRoot, entry.name))
    .filter((dir) => existsSync(join(dir, 'package.json')))
}

/**
 * Copy each built-in extension's runtime files into `<out>/extensions/<id>/`.
 * The file manifest comes from the shared packaging source (extensionPackageFiles)
 * so the deploy tree carries exactly what the desktop app stages — no drift.
 */
function stageBuiltinExtensions(out) {
  const targetRoot = join(out, 'extensions')
  mkdirSync(targetRoot, { recursive: true })
  for (const dir of builtinExtensionDirs()) {
    const id = basename(dir)
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const dest = join(targetRoot, id)
    mkdirSync(dest, { recursive: true })
    for (const file of extensionPackageFiles(manifest)) {
      const source = join(dir, ...file.split('/'))
      if (!existsSync(source)) {
        throw new Error(`builtin extension ${id} is missing ${file}`)
      }
      const target = join(dest, ...file.split('/'))
      mkdirSync(dirname(target), { recursive: true })
      cpSync(source, target, { recursive: statSync(source).isDirectory(), force: true })
    }
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
    // The typescript built-in spawns these on the remote host: ship the same
    // vendored versions the desktop app uses so `npm install` on the remote
    // reproduces the editor's language service exactly.
    'typescript-language-server': `^${await vendoredVersion('typescript-language-server', '5.3.0')}`,
    typescript: `^${await vendoredVersion('typescript', '5.8.0')}`,
  }
}
await writeFile(resolve(outDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')

if (watch) {
  const ctx = await context(buildOptions)
  await ctx.watch()
  console.log(`[remote-server] watching → ${outDir}`)
} else {
  await build(buildOptions)
  if (deploy) stageBuiltinExtensions(outDir)
  console.log(`remote-server bundled → ${outDir}`)
}
