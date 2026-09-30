/*---------------------------------------------------------------------------------------------
 *  ACP card "open to the side" (@p1).
 *
 *  卡片产出的文档除了盖在聊天上打开，还能落到聊天旁边那一组：标题行的阅读按钮按住
 *  Ctrl/Cmd 点击、或右键菜单里的「… to the Side」。单测覆盖了落点计算，这里守的是
 *  真实产物里的两处接缝：
 *    - 菜单行的 when 闸门与分组排序（只有对应口味的那一行出现，exact 匹配）；
 *    - 「按修饰键分流」——只有在真实 Chromium 里按一次 Ctrl 才算数。
 *
 *  fixture 的 `createmd` / `createtxt` 指令各产出一张整文件写入卡：前者可渲染预览，
 *  后者只能开源文件，正好覆盖 reading 入口的两种口味。
 *
 *  每个用例都从单组布局出发（`electronApp` 每用例冷启）：落点由「活动组右侧有没有
 *  邻居」决定，而点击/右键会先激活卡片所在的组，所以只有在单组起点上，期望值才是
 *  确定的。
 *--------------------------------------------------------------------------------------------*/

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/electronApp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SD_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'sessionDiffAgent.cjs')

const OPEN_PREVIEW_SIDE = { name: 'Open Preview to the Side', exact: true }
const OPEN_FILE_SIDE = { name: 'Open File to the Side', exact: true }

/** Cold-start a session on the session-diff agent, then return the card for
 *  `create(md|txt)`. */
async function startSessionWithCard(page: Page, directive: 'createmd' | 'createtxt') {
  await page.evaluate(([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p), [
    'sd',
    SD_AGENT_PATH,
  ] as const)
  await page.evaluate(() => {
    void window.__E2E__!.runCommand('workbench.action.agent.newSession')
  })
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount()), { timeout: 10000 })
    .toBe(1)
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()))
    .toBe('acp.session')

  await page.evaluate((d) => window.__E2E__!.sendAcpPrompt(d), directive)
  const key = directive === 'createmd' ? 't:sd-create-md' : 't:sd-create-txt'
  const card = page.locator(`[data-timeline-key^="${key}"]`).first()
  await expect(card).toBeVisible({ timeout: 10000 })
  // The card's own header row: an expanded card's centre sits on a child, and a
  // right-click there must target the card itself.
  return { card, header: card.locator('> [data-testid="acp-collapsible-toggle"]') }
}

test.describe('@p1 acp card open to the side', () => {
  test('the menu opens the preview in a group beside the chat', async ({ page, workbench }) => {
    await workbench.waitForRestored()
    const { header } = await startSessionWithCard(page, 'createmd')
    const chatGroup = await workbench.getActiveGroupId()
    expect(await workbench.getEditorGroupCount()).toBe(1)

    await header.click({ button: 'right' })
    await expect(page.getByRole('menuitem', OPEN_PREVIEW_SIDE)).toBeVisible({ timeout: 3000 })
    // A previewable card gets the preview flavour of the row, and only that one.
    await expect(page.getByRole('menuitem', OPEN_FILE_SIDE)).toHaveCount(0)
    await page.getByRole('menuitem', OPEN_PREVIEW_SIDE).click()

    await expect.poll(() => workbench.getEditorGroupCount()).toBe(2)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()))
      .toBe('markdown.preview')
    // Beside the chat, not over it: the document took a group of its own.
    expect(await workbench.getActiveGroupId()).not.toBe(chatGroup)
  })

  test('the menu offers the plain-file row on a card with no preview', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()
    const { header } = await startSessionWithCard(page, 'createtxt')
    const chatGroup = await workbench.getActiveGroupId()

    await header.click({ button: 'right' })
    await expect(page.getByRole('menuitem', OPEN_FILE_SIDE)).toBeVisible({ timeout: 3000 })
    await expect(page.getByRole('menuitem', OPEN_PREVIEW_SIDE)).toHaveCount(0)
    await page.getByRole('menuitem', OPEN_FILE_SIDE).click()

    await expect.poll(() => workbench.getEditorGroupCount()).toBe(2)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()))
      .toBe('file')
    expect(await workbench.getActiveGroupId()).not.toBe(chatGroup)
  })

  test('Ctrl+click on the header button opens beside the chat', async ({ page, workbench }) => {
    await workbench.waitForRestored()
    const { card } = await startSessionWithCard(page, 'createtxt')
    const chatGroup = await workbench.getActiveGroupId()

    await card.getByTestId('acp-toolcall-open-file').click({ modifiers: ['Control'] })

    await expect.poll(() => workbench.getEditorGroupCount()).toBe(2)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()))
      .toBe('file')
    expect(await workbench.getActiveGroupId()).not.toBe(chatGroup)
  })

  test('a later Ctrl+click reuses the group the first one opened', async ({ page, workbench }) => {
    await workbench.waitForRestored()
    const { card: mdCard } = await startSessionWithCard(page, 'createmd')

    await mdCard.getByTestId('acp-toolcall-open-preview').click({ modifiers: ['Control'] })
    await expect.poll(() => workbench.getEditorGroupCount()).toBe(2)

    // A second document, from the same chat: it must join the group the first
    // one opened instead of splitting the layout further. Clicking the card
    // activates the chat's group first (the group body activates on mousedown),
    // so the side group is found as its right neighbour rather than the chat
    // group being pushed one more step to the left.
    await page.evaluate(() => window.__E2E__!.sendAcpPrompt('createtxt'))
    const txtCard = page.locator('[data-timeline-key^="t:sd-create-txt"]').first()
    await expect(txtCard).toBeVisible({ timeout: 10000 })

    await txtCard.getByTestId('acp-toolcall-open-file').click({ modifiers: ['Control'] })

    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()))
      .toBe('file')
    expect(await workbench.getEditorGroupCount()).toBe(2)
  })

  test('a plain click keeps the document over the chat', async ({ page, workbench }) => {
    await workbench.waitForRestored()
    const { card } = await startSessionWithCard(page, 'createmd')
    const chatGroup = await workbench.getActiveGroupId()

    await card.getByTestId('acp-toolcall-open-preview').click()

    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()))
      .toBe('markdown.preview')
    expect(await workbench.getEditorGroupCount()).toBe(1)
    expect(await workbench.getActiveGroupId()).toBe(chatGroup)
  })
})
