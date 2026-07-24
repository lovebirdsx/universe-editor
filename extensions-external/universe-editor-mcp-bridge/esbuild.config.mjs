/*
 * Build for the standalone Universe Editor MCP bridge extension. Lives OUTSIDE
 * the pnpm workspace (ships as a `.vsix`): esbuild is borrowed from a workspace
 * extension that installs it (`extensions/typescript`), `@universe-editor/extension-api`
 * is aliased to its built dist, and the bridge's runtime deps
 * (`@modelcontextprotocol/server`, `zod`) come from this directory's own
 * `node_modules` (`npm install` here) and get bundled in.
 *
 * Two bundles come out of here:
 *   - dist/extension.js            — runs inside the extension host
 *   - resources/bridge/bridge.mjs  — the MCP server, spawned by the agent
 *                                    through Electron-as-node
 */
import { createRequire } from 'node:module'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(root, '../..')
const require = createRequire(resolve(repoRoot, 'extensions/typescript/package.json'))
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
  sourcemap: false,
  logLevel: 'info',
  banner,
}

const extensionBuildOptions = {
  ...shared,
  entryPoints: [resolve(root, 'src/extension.ts')],
  outfile: resolve(root, 'dist/extension.js'),
  sourcemap: true,
  alias: { '@universe-editor/extension-api': apiEntry },
}

const bridgeBuildOptions = {
  ...shared,
  entryPoints: [resolve(root, 'src/bridge/index.ts')],
  outfile: resolve(root, 'resources/bridge/bridge.mjs'),
}

async function prepare() {
  if (!watch) {
    await rm(resolve(root, 'dist'), { recursive: true, force: true })
    await rm(resolve(root, 'resources'), { recursive: true, force: true })
  }
  await mkdir(resolve(root, 'dist'), { recursive: true })
  await mkdir(resolve(root, 'resources/bridge'), { recursive: true })
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
