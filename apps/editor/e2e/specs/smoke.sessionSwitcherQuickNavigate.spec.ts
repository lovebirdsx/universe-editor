/*---------------------------------------------------------------------------------------------
 *  Alt+S 会话切换器的 quick-navigate 手势（@p0）。
 *
 *  与 Ctrl+Tab 同款：面板以锁定态打开（输入框只读 + 底部提示），按住 Alt 连点 S 逐行走
 *  （Shift 反向），松开 Alt 直接打开高亮项；先按 Enter 才交还输入权用于过滤。
 *
 *  用真实按键驱动（不是 runCommand）：`alt+s` 的 when 子句、面板对重复按键的接管都必须
 *  走一遍全局键盘 handler 才算验证过——面板可见期若还能命中 `alt+s`，全局层会吞掉这次
 *  按键（只有 Escape 会真的执行），连点循环随即失效。
 *
 *  断言用的是列表自身的行序（从 DOM 读 label 定位当前会话下标），不假设 main 的 fan-out
 *  顺序。
 *--------------------------------------------------------------------------------------------*/

import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../fixtures/electronApp.js'
import type { Page } from '@playwright/test'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')

function rowLabels(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="quick-input"] [role="option"]'),
    ).map((el) => el.textContent ?? ''),
  )
}

function selectedRowIndex(page: Page): Promise<number> {
  return page.evaluate(() =>
    Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="quick-input"] [role="option"]'),
    ).findIndex((el) => el.getAttribute('aria-selected') === 'true'),
  )
}

function activeEditorUri(page: Page): Promise<string | undefined> {
  return page.evaluate(() => window.__E2E__!.getActiveEditorUri())
}

/** 新建一个会落到 active group 的会话，用首条 prompt 给它可定位的标题，返回它的 editor URI。 */
async function newEchoSession(page: Page, count: number, prompt: string): Promise<string> {
  await page.evaluate(() => {
    void window.__E2E__!.runCommand('workbench.action.agent.newSession')
  })
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount()), { timeout: 15000 })
    .toBe(count)
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()))
    .toBe('acp.session')
  await page.evaluate((t) => window.__E2E__!.sendAcpPrompt(t), prompt)
  const uri = await activeEditorUri(page)
  if (uri === undefined) throw new Error('expected the new session to become the active editor')
  return uri
}

/** Alt 按住不放地打开切换器——松手即切，所以需要它保持按住的用例必须走这条路径。 */
async function openHoldingAlt(page: Page): Promise<void> {
  await page.keyboard.down('Alt')
  await page.keyboard.press('s')
}

/** 等三条 prompt 都进了列表：标题在 sendPrompt 内写 history，与切换器条目同源。 */
async function waitForRows(page: Page, prompts: readonly string[]): Promise<string[]> {
  await expect
    .poll(
      async () => {
        const labels = await rowLabels(page)
        return prompts.every((p) => labels.some((l) => l.includes(p)))
      },
      { timeout: 10000 },
    )
    .toBe(true)
  return rowLabels(page)
}

test.describe('@p0 Alt+S quick-navigate', () => {
  test.use({
    workspaceSeeder: {
      seed(dir) {
        writeFileSync(resolve(dir, 'switcher-notes.txt'), 'switcher notes\n')
      },
    },
  })

  // 失败路径可能停在 Alt 按住的状态，别让它漏给同一个 app 实例的后续步骤。
  test.afterEach(async ({ page }) => {
    await page.keyboard.up('Alt')
  })

  test('holding Alt and tapping S cycles the list, releasing Alt switches @p0', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()
    await page.evaluate(([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p), [
      'echo',
      ECHO_AGENT_PATH,
    ] as const)

    const prompts = ['SESSION-ALPHA', 'SESSION-BETA', 'SESSION-GAMMA'] as const
    const uriByPrompt = new Map<string, string>()
    for (const [i, prompt] of prompts.entries()) {
      uriByPrompt.set(prompt, await newEchoSession(page, i + 1, prompt))
    }

    await openHoldingAlt(page)
    await workbench.quickInput.waitForVisible()

    // 锁定态：输入框只读、底部提示点名了 Alt。
    await expect(workbench.quickInput.input).toHaveAttribute('readonly', '')
    await expect(workbench.quickInput.hint).toBeVisible()
    await expect(workbench.quickInput.hint).toContainText('Alt')

    const labels = await waitForRows(page, prompts)
    // 行数与会话数一致，下面的下标推算才不含混进来的行。
    expect(labels).toHaveLength(prompts.length)
    const currentIdx = labels.findIndex((l) => l.includes('SESSION-GAMMA'))
    const nextIdx = (currentIdx + 1) % labels.length

    // 开局高亮 = 当前会话的下一行：直接松手就切走，一次手势完成。
    await expect.poll(() => selectedRowIndex(page)).toBe(nextIdx)

    // 连点 S 逐行走（Alt 仍按住）。这条同时守住 when 子句：面板可见期若还能命中
    // `alt+s`，全局 handler 会吞掉按键，高亮会停在这里不动。
    await page.keyboard.press('s')
    await expect.poll(() => selectedRowIndex(page)).toBe((nextIdx + 1) % labels.length)

    // Alt+Shift+S 反向走回来。
    await page.keyboard.press('Shift+s')
    await expect.poll(() => selectedRowIndex(page)).toBe(nextIdx)

    // 松开 Alt 直接打开高亮项。
    await page.keyboard.up('Alt')
    await workbench.quickInput.waitForHidden()

    const target = prompts.find((p) => labels[nextIdx]!.includes(p))
    if (target === undefined) throw new Error(`no prompt matched row "${labels[nextIdx]}"`)
    await expect.poll(() => activeEditorUri(page)).toBe(uriByPrompt.get(target))
  })

  test('Enter hands the field over for filtering instead of switching @p0', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()
    await page.evaluate(([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p), [
      'echo',
      ECHO_AGENT_PATH,
    ] as const)

    const prompts = ['SESSION-ALPHA', 'SESSION-BETA'] as const
    const uriByPrompt = new Map<string, string>()
    for (const [i, prompt] of prompts.entries()) {
      uriByPrompt.set(prompt, await newEchoSession(page, i + 1, prompt))
    }

    await openHoldingAlt(page)
    await workbench.quickInput.waitForVisible()
    await waitForRows(page, prompts)

    // Enter 只交还输入权，不切；松手也不再切（监听已随解锁摘掉）。
    await page.keyboard.press('Enter')
    await expect(workbench.quickInput.input).not.toHaveAttribute('readonly', '')
    await expect(workbench.quickInput.hint).toBeHidden()
    await page.keyboard.up('Alt')
    await expect(workbench.quickInput.dialog).toBeVisible()

    // 过滤收敛到一行，再 Enter 才真的切过去。
    await page.keyboard.type('SESSION-BETA')
    const rows = workbench.quickInput.dialog.getByRole('option')
    await expect.poll(() => rows.count()).toBe(1)
    await expect(rows.first()).toHaveAttribute('aria-selected', 'true')

    await page.keyboard.press('Enter')
    await workbench.quickInput.waitForHidden()
    await expect.poll(() => activeEditorUri(page)).toBe(uriByPrompt.get('SESSION-BETA'))
  })
})
