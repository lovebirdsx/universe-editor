/*---------------------------------------------------------------------------------------------
 *  ACP agent 孤儿清扫（docs/development/process-lifecycle.md）：
 *  agent 存活期间，job 内“父进程已退出”的后代由定时 sweep 回收；父进程仍活着的后代不受影响。
 *
 *  夹具构造（均走 echoAgent 的 env 开关）：
 *    - ECHO_AGENT_ORPHAN_FILE：agent 经一次性的 PowerShell 中间进程启动 sleeper，中间进程
 *      随即退出 — 快照里 sleeper 的 ppid 已成死链，是 sweep 的目标。
 *    - ECHO_AGENT_PID_FILE：agent 直接 spawn 的孙进程，父（agent）仍存活 — 必须保留。
 *  编辑器以 UNIVERSE_ORPHAN_SWEEP_MS=400 启动（scoped fixture），断言窗口 ~10s。
 *--------------------------------------------------------------------------------------------*/

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../fixtures/processLifecycleOrphanApp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: exists but not ours — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function readPids(file: string): { agent: number; grandchild: number } | undefined {
  if (!existsSync(file)) return undefined
  const [agent, grandchild] = readFileSync(file, 'utf8').trim().split(/\s+/).map(Number)
  if (!Number.isInteger(agent) || !Number.isInteger(grandchild)) return undefined
  return { agent: agent!, grandchild: grandchild! }
}

function readPid(file: string): number | undefined {
  if (!existsSync(file)) return undefined
  const pid = Number(readFileSync(file, 'utf8').trim())
  return Number.isInteger(pid) ? pid : undefined
}

test.describe('ACP agent orphan sweep', () => {
  test('reaps a dead-parent descendant but keeps the live tree @regression', async ({
    page,
    workbench,
    scratchDir,
  }) => {
    test.skip(process.platform !== 'win32', 'orphan detection uses Windows process snapshots')
    await workbench.waitForRestored()
    const folder = scratchDir('universe-editor-e2e-life-orphan-')
    const pidFile = join(folder, 'agent.pids')
    const orphanFile = join(folder, 'agent.orphan')

    await workbench.openWorkspace(folder)
    await page.evaluate(
      ([id, p, pidFileArg, orphanFileArg]) =>
        window.__E2E__!.installAcpEchoAgent(id, p, {
          ECHO_AGENT_PID_FILE: pidFileArg,
          ECHO_AGENT_ORPHAN_FILE: orphanFileArg,
        }),
      ['echo', ECHO_AGENT_PATH, pidFile, orphanFile] as const,
    )
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.agent.newSession')
    })
    await expect.poll(() => readPids(pidFile), { timeout: 15000 }).toBeDefined()
    await expect.poll(() => readPid(orphanFile), { timeout: 15000 }).toBeDefined()
    const pids = readPids(pidFile)!
    const orphan = readPid(orphanFile)!
    expect(isAlive(orphan)).toBe(true)

    // sweep 每 400ms 一次；孤儿在 ~10s 内消失。
    await expect.poll(() => isAlive(orphan), { timeout: 12000 }).toBe(false)
    // agent 与其直接孙进程的父仍然存活，不能被当成孤儿清掉。
    expect(isAlive(pids.agent)).toBe(true)
    expect(isAlive(pids.grandchild)).toBe(true)
  })
})
