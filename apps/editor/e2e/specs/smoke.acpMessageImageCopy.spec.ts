/*---------------------------------------------------------------------------------------------
 *  ACP message-card image copy (@p1).
 *
 *  Covers the three user-visible promises of "Copy as Image":
 *   1. only message cards offer it (a tool-call card must not);
 *   2. it writes a PNG to the OS clipboard — @serial because the clipboard is a
 *      cross-worker global resource;
 *   3. a folded card is expanded for the capture and folded again afterwards.
 *--------------------------------------------------------------------------------------------*/

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/sharedApp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')

test.describe('@p1 acp message image copy', () => {
  async function startSession(page: Page): Promise<void> {
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
  }

  test('offers Copy as Image on a message card but not on a tool-call card', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()
    await startSession(page)

    await page.evaluate(() => window.__E2E__!.sendAcpPrompt('hello from the image test'))
    const message = page.locator('[data-testid="acp-message-agent"]').last()
    await expect(message).toBeVisible({ timeout: 10000 })

    await message.click({ button: 'right' })
    await expect(page.getByRole('menuitem', { name: 'Copy as Image' })).toBeVisible({
      timeout: 3000,
    })
    await page.keyboard.press('Escape')

    // The echo agent also emits an `echo-tool` tool call; it is not a message.
    // Tool calls are hidden under the shipped onlyMessage default, so pin the
    // default display mode before looking for the card.
    await page.evaluate(() => window.__E2E__!.setAcpCollapseMode('default'))
    const toolCall = page.locator('[data-timeline-key="t:echo-tool"]')
    await expect(toolCall).toBeVisible({ timeout: 10000 })
    await toolCall.click({ button: 'right' })
    await expect(page.getByRole('menuitem', { name: 'Copy Message' })).toBeVisible({
      timeout: 3000,
    })
    await expect(page.getByRole('menuitem', { name: 'Copy as Image' })).toHaveCount(0)
    await page.keyboard.press('Escape')
  })

  test(
    'writes a PNG to the clipboard and restores a folded card',
    { tag: '@serial' },
    async ({ page, electronApp, workbench }) => {
      await workbench.waitForRestored()
      await startSession(page)

      await page.evaluate(() => window.__E2E__!.sendAcpPrompt('hello from the image test'))
      const message = page.locator('[data-testid="acp-message-agent"]').last()
      await expect(message).toBeVisible({ timeout: 10000 })

      // Clobber the clipboard so the later image read proves the action ran.
      await electronApp.evaluate(({ clipboard }) => clipboard.writeText('sentinel'))
      expect(await electronApp.evaluate(({ clipboard }) => clipboard.readImage().isEmpty())).toBe(
        true,
      )

      // A folded card still copies its full body, then folds back.
      const toggle = message.locator('> [data-testid="acp-collapsible-toggle"]')
      await toggle.click()
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')

      await toggle.click({ button: 'right' })
      const item = page.getByRole('menuitem', { name: 'Copy as Image' })
      await expect(item).toBeVisible({ timeout: 3000 })
      await item.click()

      await expect
        .poll(() => electronApp.evaluate(({ clipboard }) => !clipboard.readImage().isEmpty()), {
          timeout: 10000,
        })
        .toBe(true)
      const size = await electronApp.evaluate(({ clipboard }) => clipboard.readImage().getSize())
      expect(size.width).toBeGreaterThan(0)
      expect(size.height).toBeGreaterThan(0)
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    },
  )
})
