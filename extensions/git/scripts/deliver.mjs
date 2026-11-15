#!/usr/bin/env node
/**
 * Bundle the headless delivery CLI with esbuild and run it from a temporary
 * directory. Importing the TS entry directly would need a TS loader; bundling
 * also proves the CLI never reaches back into the extension host.
 */
import { build } from 'esbuild'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkTempDir, removeDirWithRetry } from '../../../scripts/lib/temp-root.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const entry = resolve(here, '../src/delivery/deliveryCli.ts')

const forbidExtensionHost = {
  name: 'forbid-extension-host',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^@universe-editor\/extension-api(?:\/.*)?$/ }, (args) => {
      throw new Error(
        `[deliver] ${entry} must stay host-free, but ${args.importer} imports ${args.path}`,
      )
    })
  },
}

const tempDir = mkTempDir('ue-deliver-')
const outfile = join(tempDir, 'deliveryCli.mjs')

try {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    minify: false,
    sourcemap: false,
    logLevel: 'warning',
    banner: {
      js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
    },
    plugins: [forbidExtensionHost],
  })
  const cli = await import(pathToFileURL(outfile).href)
  process.exitCode = await cli.main(process.argv.slice(2))
} catch (err) {
  console.error('[deliver] 启动失败:', err instanceof Error ? err.message : err)
  process.exitCode = 1
} finally {
  removeDirWithRetry(tempDir)
}
