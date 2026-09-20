import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Locator } from '@playwright/test'
import { createColdAppTest, expect } from '@universe-editor/e2e-harness'
import { APP_ROOT, MAIN_ENTRY } from '../fixtures/electronApp.js'

const test = createColdAppTest({
  appRoot: APP_ROOT,
  mainEntry: MAIN_ENTRY,
  extensions: ['@universe-editor/theme-defaults'],
})
const ECHO_AGENT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'src',
  'test-fixtures',
  'echoAgent.cjs',
)

function outline(card: Locator) {
  return card.evaluate((element) => {
    const style = getComputedStyle(element)
    // Canvas 将浏览器的 rgb / color(srgb) 序列化统一为可比较的 alpha。
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const context = canvas.getContext('2d')!
    context.fillStyle = style.outlineColor
    context.fillRect(0, 0, 1, 1)
    return {
      color: style.outlineColor,
      alpha: context.getImageData(0, 0, 1, 1).data[3],
      style: style.outlineStyle,
      width: style.outlineWidth,
      offset: style.outlineOffset,
    }
  })
}

for (const theme of ['Dark', 'Light'] as const) {
  test(`${theme}：输入框与其他分屏获得焦点后保留弱选中描边 @regression`, async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    await page.evaluate((name) => {
      window.__E2E__!.updateConfigValue('workbench.colorTheme', `Universe ${name}`)
    }, theme)
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
      .toBe(theme.toLowerCase())
    await page.evaluate(([id, path]) => window.__E2E__!.installAcpEchoAgent(id, path), [
      'echo',
      ECHO_AGENT_PATH,
    ] as const)
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.agent.newSession')
    })
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()))
      .toBe('acp.session')
    await expect.poll(() => workbench.getFocusedChatSurface()).toBe('prompt')
    await page.evaluate(() => window.__E2E__!.sendAcpPrompt('alpha'))
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpMessages().length), { timeout: 15000 })
      .toBe(2)

    const groupId = await workbench.getActiveGroupId()
    expect(groupId).toBeDefined()
    const group = page.locator(`[data-group-id="${groupId}"]`)
    const card = group.getByTestId('acp-message-agent').first()
    await expect(card).toBeVisible()
    expect((await outline(card)).style).toBe('none')
    await card.click()
    await expect.poll(() => workbench.getFocusedChatSurface()).toBe('timeline')
    await expect.poll(async () => (await outline(card)).alpha).toBe(255)
    const active = await outline(card)
    expect(active.style).toBe('solid')
    expect(active.width).toBe('1px')

    await workbench.runCommand('workbench.action.agent.focusInput')
    await expect.poll(() => workbench.getFocusedChatSurface()).toBe('prompt')
    await expect.poll(async () => (await outline(card)).alpha).toBeLessThan(active.alpha!)
    const inactive = await outline(card)
    expect(inactive.alpha).toBeGreaterThan(0)
    expect(inactive.style).toBe(active.style)
    expect(inactive.width).toBe(active.width)
    expect(inactive.offset).toBe(active.offset)

    await card.click()
    await expect.poll(() => outline(card)).toEqual(active)
    await workbench.runCommand('workbench.action.splitEditorRight')
    await expect.poll(() => workbench.getEditorGroupCount()).toBe(2)
    await expect.poll(() => workbench.getActiveGroupId()).not.toBe(groupId)
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.activeElement?.closest('[data-group-id]')?.getAttribute('data-group-id'),
        ),
      )
      .not.toBe(groupId)
    await expect.poll(() => outline(card)).toEqual(inactive)

    await card.click()
    await expect(group).toHaveAttribute('data-group-active', 'true')
    await expect.poll(() => outline(card)).toEqual(active)
  })
}
