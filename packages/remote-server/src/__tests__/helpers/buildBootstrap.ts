/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Test helper: bundles src/bootstrap.ts into a runnable ESM file inside the
 *  package (so node resolves the external native deps from packages/remote-server/
 *  node_modules) and returns its path for spawning in subcommand tests.
 *--------------------------------------------------------------------------------------------*/

import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)))

// 这些目录建在包目录内（必须在包内才能解析原生依赖），pnpm tmp:clean 按临时根 + 前缀扫不到，
// 只能靠 dispose()。而用例抛错/整轮被打断时 dispose 未必执行，于是加一层同步 exit 兜底——
// 与 bootstrap.test.ts 里 daemonPids 的写法同源。
const createdDirs = new Set<string>()

process.once('exit', () => {
  for (const dir of createdDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 已删除或卸载中的 fs。
    }
  }
})

export interface BuiltBootstrap {
  readonly bootstrapPath: string
  dispose(): Promise<void>
}

export async function buildBootstrapBundle(): Promise<BuiltBootstrap> {
  const dir = await mkdtemp(path.join(packageRoot, '.tmp-bootstrap-'))
  createdDirs.add(dir)
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
      createdDirs.delete(dir)
    },
  }
}
