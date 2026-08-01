/*
 * Build for the standalone Universe Editor MCP bridge extension. Lives OUTSIDE
 * the pnpm workspace (ships as a `.vsix`): esbuild is borrowed from a workspace
 * extension that installs it (`extensions/typescript`); the bridge's runtime
 * deps (`@modelcontextprotocol/server`, `zod`) come from this directory's own
 * `node_modules` (`npm install` here) and get bundled in.
 *
 * Single bundle: resources/bridge/bridge.mjs — the MCP server, spawned by the
 * agent through Electron-as-node. The extension itself is purely declarative
 * (`contributes.mcpServers` in package.json) and has no host-side code.
 */
import { createRequire } from 'node:module'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(root, '../..')
const require = createRequire(resolve(repoRoot, 'extensions/typescript/package.json'))
const { build, context } = await import(pathToFileURL(require.resolve('esbuild')).href)

const watch = process.argv.includes('--watch')

const banner = {
  js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
}

/** @type {import('esbuild').BuildOptions} */
const bridgeBuildOptions = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  minify: false,
  sourcemap: false,
  logLevel: 'info',
  banner,
  entryPoints: [resolve(root, 'src/bridge/index.ts')],
  outfile: resolve(root, 'resources/bridge/bridge.mjs'),
}

async function prepare() {
  if (!watch) {
    await rm(resolve(root, 'dist'), { recursive: true, force: true })
    await rm(resolve(root, 'resources'), { recursive: true, force: true })
  }
  await mkdir(resolve(root, 'resources/bridge'), { recursive: true })
}

await prepare()

if (watch) {
  const bridgeCtx = await context(bridgeBuildOptions)
  await bridgeCtx.watch()
  console.log('[universe-editor-mcp-bridge] watching...')
} else {
  await build(bridgeBuildOptions)
  console.log('universe-editor-mcp-bridge bundled -> resources/bridge/bridge.mjs')
}
