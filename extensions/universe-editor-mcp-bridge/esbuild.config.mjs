import { build, context } from 'esbuild'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const outFile = resolve(root, 'dist/extension.js')
const resourcesRoot = resolve(root, 'resources/bridge')
const bridgeOutFile = resolve(resourcesRoot, 'bridge.mjs')
const watch = process.argv.includes('--watch')

const extensionBuildOptions = {
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
}

const bridgeBuildOptions = {
  entryPoints: [resolve(root, 'src/bridge/index.ts')],
  outfile: bridgeOutFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  minify: false,
  sourcemap: false,
  logLevel: 'info',
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
}

async function prepare() {
  if (!watch) {
    await rm(resolve(root, 'dist'), { recursive: true, force: true })
    await rm(resolve(root, 'resources'), { recursive: true, force: true })
  }
  await mkdir(resolve(root, 'dist'), { recursive: true })
  await mkdir(resourcesRoot, { recursive: true })
  await writeFile(
    resolve(root, 'dist/package.json'),
    JSON.stringify({ type: 'module' }, null, 2) + '\n',
  )
}

await prepare()

if (watch) {
  const extensionCtx = await context(extensionBuildOptions)
  const bridgeCtx = await context(bridgeBuildOptions)
  await Promise.all([extensionCtx.watch(), bridgeCtx.watch()])
  console.log('[universe-editor-mcp-bridge] watching...')
} else {
  await Promise.all([build(extensionBuildOptions), build(bridgeBuildOptions)])
  console.log(
    'universe-editor-mcp-bridge extension bundled -> dist/extension.js, resources/bridge/bridge.mjs',
  )
}
