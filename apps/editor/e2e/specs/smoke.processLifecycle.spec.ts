/*---------------------------------------------------------------------------------------------
 *  OS 级进程生命周期绑定（docs/development/process-lifecycle.md）：
 *    1. 关闭窗口 → 该窗口 ACP agent 及其孙进程（Windows：Job Object；POSIX：进程组）一并消失，
 *       而另一个窗口的 agent 不受影响。
 *    2. 强杀 main（无任何清理机会）→ agent 与孙进程不残留（Windows：job 句柄随 main 关闭；
 *       POSIX：agent 的 stdin-EOF 看门狗，孙进程由其退出路径回收，故只断言 agent 本体 + 孙进程最终消失）。
 *
 *  agent 用 echoAgent 的 ECHO_AGENT_PID_FILE 开关：启动时再拉一个孙进程并落盘 "<agent> <grandchild>"。
 *  Windows 以外只覆盖用例 1：强杀 main 后 POSIX 的孙进程回收依赖 agent 自身看门狗，不属于本机制保证。
 *--------------------------------------------------------------------------------------------*/

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../fixtures/processLifecycleApp.js'
import { evaluateWhenRestored, waitForProbeServiceable } from '../pages/WorkbenchPO.js'

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

test.describe('process lifecycle binding', () => {
  test('closing a window reaps its agent tree but leaves another window untouched @p1', async ({
    electronApp,
    page,
    workbench,
    scratchDir,
  }) => {
    await workbench.waitForRestored()
    const folderA = scratchDir('universe-editor-e2e-life-a-')
    const folderB = scratchDir('universe-editor-e2e-life-b-')
    const pidFileA = join(folderA, 'agent.pids')
    const pidFileB = join(folderB, 'agent.pids')

    // A runs in the primary window; B (opened next) keeps the app alive when A closes.
    await workbench.openWorkspace(folderA)
    await page.evaluate(
      ([id, p, pidFile]) =>
        window.__E2E__!.installAcpEchoAgent(id, p, { ECHO_AGENT_PID_FILE: pidFile }),
      ['echo', ECHO_AGENT_PATH, pidFileA] as const,
    )
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.agent.newSession')
    })
    await expect.poll(() => readPids(pidFileA), { timeout: 15000 }).toBeDefined()
    const a = readPids(pidFileA)!

    const newWindow = electronApp.waitForEvent('window')
    await workbench.openFolderInNewWindow(folderB)
    const page2 = await newWindow
    await page2.waitForFunction(() =>
      Boolean((window as unknown as Record<string, unknown>)['__E2E__']),
    )
    await evaluateWhenRestored(page2)
    await waitForProbeServiceable(page2)
    await page2.evaluate(
      ([id, p, pidFile]) =>
        window.__E2E__!.installAcpEchoAgent(id, p, { ECHO_AGENT_PID_FILE: pidFile }),
      ['echo', ECHO_AGENT_PATH, pidFileB] as const,
    )
    await page2.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.agent.newSession')
    })
    await expect.poll(() => readPids(pidFileB), { timeout: 15000 }).toBeDefined()
    const b = readPids(pidFileB)!
    expect([a.agent, a.grandchild, b.agent, b.grandchild].every(isAlive)).toBe(true)

    const windows = await workbench.getOpenWindows()
    const target = windows.find((w) => w.folder === folderA.replace(/\\/g, '/'))
    expect(target).toBeDefined()
    await electronApp.evaluate(({ BrowserWindow }, id) => {
      BrowserWindow.fromId(id)?.close()
    }, target!.id)
    await expect.poll(() => electronApp.windows().length, { timeout: 8000 }).toBe(1)

    await expect.poll(() => isAlive(a.agent), { timeout: 15000 }).toBe(false)
    await expect.poll(() => isAlive(a.grandchild), { timeout: 15000 }).toBe(false)
    expect(isAlive(b.agent)).toBe(true)
    expect(isAlive(b.grandchild)).toBe(true)
  })

  test('force-killing main leaves no agent or grandchild behind @regression', async ({
    electronApp,
    page,
    workbench,
    scratchDir,
  }) => {
    test.skip(process.platform !== 'win32', 'Job Object guarantee; POSIX relies on agent watchdog')
    await workbench.waitForRestored()
    const folder = scratchDir('universe-editor-e2e-life-kill-')
    const pidFile = join(folder, 'agent.pids')

    await workbench.openWorkspace(folder)
    await page.evaluate(
      ([id, p, pidFileArg]) =>
        window.__E2E__!.installAcpEchoAgent(id, p, {
          ECHO_AGENT_PID_FILE: pidFileArg,
          ECHO_AGENT_IGNORE_STDIN_EOF: '1',
        }),
      ['echo', ECHO_AGENT_PATH, pidFile] as const,
    )
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.agent.newSession')
    })
    await expect.poll(() => readPids(pidFile), { timeout: 15000 }).toBeDefined()
    const pids = readPids(pidFile)!
    expect(isAlive(pids.agent) && isAlive(pids.grandchild)).toBe(true)

    // electronApp.process().pid can be a launcher wrapper; the job is bound to the real main.
    const mainPid = await electronApp.evaluate(() => process.pid)
    expect(isAlive(mainPid)).toBe(true)
    // TerminateProcess on main only: no taskkill /T, so nothing but the OS can reap the tree.
    process.kill(mainPid, 'SIGKILL')

    await expect.poll(() => isAlive(pids.agent), { timeout: 15000 }).toBe(false)
    await expect.poll(() => isAlive(pids.grandchild), { timeout: 15000 }).toBe(false)
  })

  test('an agent exiting on its own reaps its tree at release @regression', async ({
    page,
    workbench,
    scratchDir,
  }) => {
    test.skip(process.platform !== 'win32', 'PowerShell wrapper fixture is Windows-only')
    await workbench.waitForRestored()
    const folder = scratchDir('universe-editor-e2e-life-release-')
    const pidFile = join(folder, 'agent.pids')

    await workbench.openWorkspace(folder)
    await page.evaluate(
      ([id, p, pidFileArg]) =>
        window.__E2E__!.installAcpEchoAgent(id, p, {
          ECHO_AGENT_PID_FILE: pidFileArg,
          // 孙进程走 PowerShell wrapper：它不在 Node 给自己的子进程建的 per-process job
          // 里，agent 退出不会连带杀掉它——只有编辑器的释放回收能清掉。
          ECHO_AGENT_TREE_VIA_WRAPPER: '1',
          ECHO_AGENT_EXIT_AFTER_MS: '3000',
        }),
      ['echo', ECHO_AGENT_PATH, pidFile] as const,
    )
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.agent.newSession')
    })
    await expect.poll(() => readPids(pidFile), { timeout: 15000 }).toBeDefined()
    const pids = readPids(pidFile)!
    expect(isAlive(pids.grandchild)).toBe(true)

    await expect.poll(() => isAlive(pids.agent), { timeout: 15000 }).toBe(false)
    // 默认 sweep 是 30s，这个窗口只有释放时的 terminate+close 能解释。
    await expect.poll(() => isAlive(pids.grandchild), { timeout: 12000 }).toBe(false)
  })
})
