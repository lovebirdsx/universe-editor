/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Test helper: bundles src/bootstrap.ts into a runnable ESM file inside the
 *  package (so node resolves the external native deps from packages/remote-server/
 *  node_modules) and returns its path for spawning in subcommand tests.
 *--------------------------------------------------------------------------------------------*/

import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)))

export interface BuiltBootstrap {
  readonly bootstrapPath: string
  dispose(): Promise<void>
}

export async function buildBootstrapBundle(): Promise<BuiltBootstrap> {
  const dir = await mkdtemp(path.join(packageRoot, '.tmp-bootstrap-'))
  const bootstrapPath = path.join(dir, 'bootstrap.js')
  await build({
    entryPoints: [path.resolve(packageRoot, 'src/bootstrap.ts')],
    outfile: bootstrapPath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    external: ['@parcel/watcher', '@vscode/ripgrep'],
    banner: {
      js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
    },
  })
  return {
    bootstrapPath,
    async dispose(): Promise<void> {
      await rm(dir, { recursive: true, force: true })
    },
  }
}
