/*---------------------------------------------------------------------------------------------
 *  Sessions view 会话行的状态表达（@p1）。
 *
 *  两个状态互相独立、经常落在不同的行上，所以各自都得一眼可辨：
 *  - 键盘光标（aria-selected）= 当前聚焦的会话 → 蓝色整体高亮
 *  - data-active（activeSessionId）= 编辑器里打开着的会话 → 1px 蓝色边框
 *  两者同行时叠加；列表失去 DOM 焦点时高亮降级为暗色，边框不受影响。
 *  反转前二者恰好相反（光标画边框、打开中的会话铺背景），这组断言就是为了
 *  防止再被翻回去。
 *
 *  只有 e2e 守得住：断言的是计算样式，CSS Modules 在 happy-dom 下不生效，
 *  而期望色来自主题注入的 --vscode-* 变量，所以 Dark / Light 各跑一遍。
 *  （同样性质的先例：smoke.sessionEditorSelectionAppearance。）
 *--------------------------------------------------------------------------------------------*/

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Locator, Page } from '@playwright/test'
import { expect, test } from '../fixtures/coreThemesApp.js'
import type { WorkbenchPO } from '../pages/WorkbenchPO.js'

const ECHO_AGENT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'src',
  'test-fixtures',
  'echoAgent.cjs',
)

const SESSIONS_VIEW_ID = 'workbench.view.sessions.main'

/**
 * 行的实际着色，颜色一律经 canvas 归一化 —— Chromium 会把同一个颜色序列化成
 * `rgb()` / `color(srgb …)` / `#rrggbbaa` 等不同形态，比字符串会假失败。
 */
function rowPaint(row: Locator) {
  return row.evaluate((element) => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const context = canvas.getContext('2d')!
    const rgba = (value: string) => {
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = value
      context.fillRect(0, 0, 1, 1)
      const data = context.getImageData(0, 0, 1, 1).data
      return [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0, data[3] ?? 0]
    }
    const style = getComputedStyle(element)
    return {
      background: rgba(style.backgroundColor),
      outline: rgba(style.outlineColor),
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      outlineOffset: style.outlineOffset,
    }
  })
}

/**
 * 期望色从主题注入的变量上读，不硬编码 —— 同一份断言因此在两个主题下都成立，
 * 也不会把某个主题的字面色固化进套件。
 */
function themeTokens(page: Page) {
  return page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const context = canvas.getContext('2d')!
    const rgba = (value: string) => {
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = value
      context.fillRect(0, 0, 1, 1)
      const data = context.getImageData(0, 0, 1, 1).data
      return [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0, data[3] ?? 0]
    }
    const root = getComputedStyle(document.documentElement)
    const token = (name: string) => rgba(root.getPropertyValue(name).trim())
    return {
      cursorFill: token('--vscode-list-activeSelectionBackground'),
      blurredCursorFill: token('--vscode-list-inactiveSelectionBackground'),
      openBorder: token('--vscode-list-focusOutline'),
      hoverFill: token('--vscode-list-hoverBackground'),
    }
  })
}

/**
 * 把键盘光标停到「是 / 不是打开中会话」的那一行上。两行必然覆盖两种情况，所以
 * Home / End 各试一次就够；两次都不满足说明前提被破坏，响亮地抛错 —— 别让它
 * 退化成一个莫名其妙的颜色不符。
 */
async function parkCursor(page: Page, list: Locator, onOpenRow: boolean): Promise<void> {
  for (const key of ['Home', 'End']) {
    await page.keyboard.press(key)
    const onOpen = await list.locator('li[aria-selected="true"][data-active="true"]').count()
    if (onOpen > 0 === onOpenRow) return
  }
  throw new Error(`无法把光标停到${onOpenRow ? '' : '非'}打开中会话的行上`)
}

/**
 * 聚焦 Sessions view 并等焦点真正落定。
 *
 * 新开会话的输入框会在 `newSession` resolve 之后一拍抢走焦点，单发一次
 * focusView 可能被悄悄撤销 —— 连「看起来成功了」的那次也算，只要抢占还在路上。
 * 重发命令并稍后再确认一次，断言的是「焦点扛过了这一拍」而不只是「有过焦点」。
 */
async function focusSessionList(page: Page, workbench: WorkbenchPO): Promise<Locator> {
  const list = page.getByRole('listbox', { name: 'Sessions' })
  await expect
    .poll(
      async () => {
        await page.evaluate(() => window.__E2E__!.runCommand('workbench.action.agent.openView'))
        await page.waitForTimeout(500)
        return list.getAttribute('data-focused')
      },
      { timeout: 20000 },
    )
    .toBe('true')
  await expect.poll(() => workbench.getContextKey<string>('focusedView')).toBe(SESSIONS_VIEW_ID)
  return list
}

async function openTwoSessions(page: Page): Promise<void> {
  await page.evaluate(([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p), [
    'echo',
    ECHO_AGENT_PATH,
  ] as const)
  // 两行：一行是打开中的会话，另一行给光标停靠。默认 chat 位置是 'editor'，
  // 正是 Sessions view 显示这份列表的场景。
  for (const _ of [0, 1]) {
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.agent.newSession')
    })
  }
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount()), { timeout: 20000 })
    .toBe(2)
}

test.describe('@p1 agents session row states', () => {
  test.afterEach(async ({ page }) => {
    await page.evaluate(() => {
      window.__E2E__!.updateConfigValue('workbench.colorTheme', 'Universe Dark')
    })
  })

  for (const theme of ['Dark', 'Light'] as const) {
    test(`${theme}：聚焦行整体高亮、打开中的会话行画边框`, async ({ page, workbench }) => {
      test.slow()
      await workbench.waitForRestored()
      await page.evaluate((name) => {
        window.__E2E__!.updateConfigValue('workbench.colorTheme', `Universe ${name}`)
      }, theme)
      await expect
        .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
        .toBe(theme.toLowerCase())

      await openTwoSessions(page)
      const list = await focusSessionList(page, workbench)

      const tokens = await themeTokens(page)
      // 主题扩展没激活时变量是空串，后面每条断言都会以同样的方式失败；先在这里说清楚。
      expect(
        tokens.cursorFill[3],
        '--vscode-list-activeSelectionBackground 未解析',
      ).toBeGreaterThan(0)
      const cursor = list.locator('li[aria-selected="true"]')
      const open = list.locator('li[data-active="true"]')
      await expect(open).toHaveCount(1)
      expect(tokens.cursorFill).not.toEqual(tokens.blurredCursorFill)

      // 1. 聚焦的会话行 = 整体高亮，描边已经搬走。
      await parkCursor(page, list, false)
      await expect.poll(async () => (await rowPaint(cursor)).background).toEqual(tokens.cursorFill)
      expect((await rowPaint(cursor)).outlineStyle).toBe('none')

      // 2. 悬停在光标行上不能把这层高亮盖成 hover 灰 —— 那正是光标的全部意义。
      await cursor.hover()
      await expect.poll(async () => (await rowPaint(cursor)).background).toEqual(tokens.cursorFill)

      // 3. 打开中的会话行 = 蓝色边框、无填充。
      const openPaint = await rowPaint(open)
      expect(openPaint.outlineStyle).toBe('solid')
      expect(openPaint.outlineWidth).toBe('1px')
      expect(openPaint.outlineOffset).toBe('-1px')
      expect(openPaint.outline).toEqual(tokens.openBorder)
      expect(openPaint.background[3]).toBe(0)

      // 4. 悬停在普通行上仍是 hover 反馈（高亮只属于光标行）。
      await open.hover()
      await expect.poll(async () => (await rowPaint(open)).background).toEqual(tokens.hoverFill)

      // 5. 两个状态落在同一行时叠加：填充 + 边框。
      await parkCursor(page, list, true)
      const both = list.locator('li[aria-selected="true"][data-active="true"]')
      await expect(both).toHaveCount(1)
      await expect.poll(async () => (await rowPaint(both)).background).toEqual(tokens.cursorFill)
      expect((await rowPaint(both)).outlineStyle).toBe('solid')
      expect((await rowPaint(both)).outline).toEqual(tokens.openBorder)

      // 6. 列表失去 DOM 焦点：光标没被清掉（aria-selected 还在），但高亮降级为暗色；
      //    打开中会话的边框与 DOM 焦点无关，照旧。指针先移开——它还停在上一轮悬停的
      //    那一行上，而失焦之后 hover 反馈会盖过降级色（第 7 步断言的正是这一点）。
      await page.mouse.move(0, 0)
      await workbench.runCommand('workbench.action.agent.focusInput')
      await expect.poll(() => list.getAttribute('data-focused')).toBe('false')
      await expect(both).toHaveCount(1)
      await expect
        .poll(async () => (await rowPaint(both)).background)
        .toEqual(tokens.blurredCursorFill)
      expect((await rowPaint(both)).outlineStyle).toBe('solid')

      // 7. 暗色只是占位，悬停反馈排在它前面（两者同为 (0,2,0)，靠源码顺序）。
      await both.hover()
      await expect.poll(async () => (await rowPaint(both)).background).toEqual(tokens.hoverFill)

      // 8. 焦点回来，高亮跟着回来 —— 降级是跟随 DOM 焦点，不是单向的。
      await focusSessionList(page, workbench)
      await expect.poll(async () => (await rowPaint(both)).background).toEqual(tokens.cursorFill)
    })
  }
})
