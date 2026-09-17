/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  fixture 进程归属登记：把每个经 harness 启动的 Electron app 与它的 userDataDir 绑在一起，
 *  使清扫不必依赖 pid 或进程树——app 主进程被 SIGKILL（will-quit 不执行）后，只剩命令行里
 *  的 userDataDir 还能证明「这些进程属于这个 fixture」。
 *--------------------------------------------------------------------------------------------*/

import { realpathSync } from 'node:fs'
import type { ElectronApplication } from '@playwright/test'
import { formatSweepLine, sweepProcesses, type ProcessSweepPlan } from './processSweep.js'

const liveApps = new Map<ElectronApplication, string>()
let backstopInstalled = false

/** 认 `--user-data-dir=<v>` 与 `--user-data-dir <v>` 两种形态（Electron 两种都吃）。 */
export function extractUserDataDir(args: readonly string[] | undefined): string | undefined {
  if (args === undefined) return undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg.startsWith('--user-data-dir=')) return arg.slice('--user-data-dir='.length)
    if (arg === '--user-data-dir') return args[i + 1]
  }
  return undefined
}

export function registerFixtureApp(
  app: ElectronApplication,
  userDataDir: string | undefined,
): void {
  if (userDataDir === undefined || userDataDir === '') return
  liveApps.set(app, userDataDir)
  installFixtureSweepBackstop()
}

/** 总是摘掉登记，返回它占用的 userDataDir（未登记则 undefined）。 */
export function unregisterFixtureApp(app: ElectronApplication): string | undefined {
  const userDataDir = liveApps.get(app)
  liveApps.delete(app)
  return userDataDir
}

/** 仍活着的 app 的根 pid；handle 已释放的直接跳过。 */
export function liveFixtureRootPids(): number[] {
  const pids: number[] = []
  for (const app of liveApps.keys()) {
    try {
      const pid = app.process().pid
      if (pid !== undefined) pids.push(pid)
    } catch {
      // Playwright handle 已释放，进程早没了。
    }
  }
  return pids
}

/**
 * 按 userDataDir 清扫该 fixture 的残留进程。
 *
 * 排除仍在册的其他 app 的整棵子树：重启型 spec 会在同一个 userDataDir 上先后起两个 app，
 * 收第一个时绝不能带倒第二个。被 reparent 到 init 的 daemon 不在任何活体子树里，照收。
 */
export function sweepFixtureProcesses(
  userDataDir: string,
  options: { readonly dryRun?: boolean } = {},
): ProcessSweepPlan {
  const markers = [userDataDir]
  try {
    // app.getPath('userData') 可能已被解析成 realpath（CI 上 tmpdir 常是 8.3 短路径）。
    const resolved = realpathSync.native(userDataDir)
    if (resolved !== userDataDir) markers.push(resolved)
  } catch {
    // 目录已经删了，用登记时的原路径匹配即可。
  }
  return sweepProcesses(markers, {
    excludeSubtrees: liveFixtureRootPids(),
    ...(options.dryRun !== undefined ? { dryRun: options.dryRun } : {}),
  })
}

/** 退出兜底：清掉仍登记在册（即没走 closeApp）的全部 fixture 残留。 */
export function sweepRegisteredFixtureProcesses(): ProcessSweepPlan {
  const dirs = [...new Set(liveApps.values())]
  liveApps.clear()
  if (dirs.length === 0) return { pids: [], rows: [] }
  return sweepProcesses(dirs)
}

function installFixtureSweepBackstop(): void {
  if (backstopInstalled) return
  backstopInstalled = true
  // worker 退出是最后一个能回收的时机，而 Playwright 只在主进程还活着时才 force-kill
  // 进程组——主进程已退出恰好是它跳过的那一种，也是孤儿产生的场景。信号路径同样会被
  // 覆盖：Playwright 的 sigintHandler 走 gracefullyCloseAll().then(() => process.exit(130))，
  // 而 process.exit() 会触发 'exit' 事件。exit 处理器只能做同步事，扫描与 kill 都是同步的。
  process.once('exit', () => {
    try {
      const line = formatSweepLine(sweepRegisteredFixtureProcesses(), 'fixture 退出兜底')
      if (line !== '') console.warn(line)
    } catch {
      // 绝不影响退出码。
    }
  })
}
