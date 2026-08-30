/*---------------------------------------------------------------------------------------------
 *  回归：关闭带存活 ACP 会话的工作区窗口后，该工作区文件夹必须可删除。
 *
 *  背景：ACP agent 子进程以 cwd=workspace 被 app 单例 acpHost spawn。此前窗口
 *  关闭只靠 renderer beforeunload 里 fire-and-forget 的 host.stop，页面销毁时
 *  IPC 可能被丢弃——shell 包装的 agent（cmd.exe → node.exe）残留并把 cwd 钉在
 *  workspace 上，Windows 下文件夹删不掉（EBUSY），直到整个 app 退出。
 *  修复：confirmShutdown 跑完整两阶段（veto + willShutdown join），acpClientService
 *  在 join 阶段可靠 stop 全部 agent 进程后窗口才真正关闭。
 *
 *  复现前提：必须有第二个窗口保持 app 存活（Windows 上最后一个窗口关闭即
 *  app.quit()，一切句柄随之释放，锁无从谈起）。仅 Windows 有删目录锁定语义。
 *--------------------------------------------------------------------------------------------*/

import { rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../fixtures/electronApp.js'
import { evaluateWhenRestored } from '../pages/WorkbenchPO.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')

test.describe('window close releases workspace folder', () => {
  test.skip(process.platform !== 'win32', 'directory-deletion locking is Windows-specific')

  test('closing a window with a live ACP session leaves the folder deletable @regression', async ({
    electronApp,
    page,
    workbench,
    scratchDir,
  }) => {
    await workbench.waitForRestored()
    // scratchDir, so the leftover cleanup runs after closeApp: folderB stays
    // open in the surviving window for the whole test, and deleting it from the
    // test body would race handles the app still holds (the very lock this test
    // is about, just on the wrong folder).
    const folderA = tmpFolder(scratchDir('universe-editor-e2e-lock-a-'))
    writeFileSync(join(folderA.dir, 'hello.txt'), 'hello')
    const folderB = tmpFolder(scratchDir('universe-editor-e2e-lock-b-'))

    await workbench.openWorkspace(folderA.dir)
    await expect
      .poll(() => workbench.getCurrentWorkspacePath(), { timeout: 5000 })
      .toBe(folderA.fsPath)

    // 起 echo agent 会话（agent 进程 cwd = folderA），等 echo 回合完成确保连接就绪。
    await page.evaluate(([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p), [
      'echo',
      ECHO_AGENT_PATH,
    ] as const)
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.agent.newSession')
    })
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount()), { timeout: 10000 })
      .toBe(1)
    await page.evaluate(() => window.__E2E__!.sendAcpPrompt('hello'))
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpMessages()), { timeout: 5000 })
      .toEqual([
        { role: 'user', text: 'hello' },
        { role: 'agent', text: 'echo: hello' },
      ])

    // 第二窗口保活：Windows 上最后一个窗口关闭即 app.quit()，锁便无从观察。
    const newWindow = electronApp.waitForEvent('window')
    await workbench.openFolderInNewWindow(folderB.dir)
    const page2 = await newWindow
    await page2.waitForFunction(() =>
      Boolean((window as unknown as Record<string, unknown>)['__E2E__']),
    )
    await evaluateWhenRestored(page2)
    await expect.poll(() => electronApp.windows().length, { timeout: 8000 }).toBe(2)

    // 关 folderA 所在窗口（走真实 close → veto → willShutdown join 路径）。
    const windows = await workbench.getOpenWindows()
    const target = windows.find((w) => w.folder === folderA.fsPath)
    expect(target).toBeDefined()
    await electronApp.evaluate(({ BrowserWindow }, id) => {
      BrowserWindow.fromId(id)?.close()
    }, target!.id)
    await expect.poll(() => electronApp.windows().length, { timeout: 8000 }).toBe(1)

    // 修复前：agent 进程残留，rmSync 抛 EBUSY 直到 app 退出。
    // 修复后：willShutdown join 已 stop agent，文件夹立即可删。
    // 这句 rmSync 是断言本身（不是清理）——folderA 的窗口已关，锁必须已释放。
    await expect
      .poll(
        () => {
          try {
            rmSync(folderA.dir, { recursive: true })
            return true
          } catch {
            return false
          }
        },
        { timeout: 15000 },
      )
      .toBe(true)
  })
})

function tmpFolder(dir: string): { dir: string; fsPath: string } {
  return { dir, fsPath: dir.replace(/\\/g, '/') }
}
