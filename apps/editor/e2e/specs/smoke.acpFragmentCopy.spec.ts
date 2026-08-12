/*---------------------------------------------------------------------------------------------
 *  ACP fragment copy context menu (@p1).
 *
 *  Repro for "right-clicking an image in the session editor / prompt input does
 *  not offer Copy Image". Covers the three entry points:
 *    1. timeline: an agent message containing an image block
 *    2. prompt input: a pasted attachment chip
 *    3. sticky bar: the first user message pinned above the scroll container
 *       (owns its own context-menu handler — the original bug)
 *  Each then executes the menu item and asserts the OS clipboard holds an image.
 *--------------------------------------------------------------------------------------------*/

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../fixtures/sharedApp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')

// 2×2 red PNG.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAE0lEQVR4AWP8z8DwnwEImBigAAAfFwICgH3ifwAAAABJRU5ErkJggg=='

test.describe('@p1 acp fragment copy', () => {
  // @serial: verifies via the OS clipboard — a global resource shared across
  // workers (same reasoning as smoke.acpPasteImage).
  test(
    'right-clicking a timeline image offers Copy Image and writes the clipboard @regression',
    { tag: '@serial' },
    async ({ page, electronApp, workbench }) => {
      await workbench.waitForRestored()

      await page.evaluate(
        ([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p, { ECHO_AGENT_IMAGE: '1' }),
        ['echo', ECHO_AGENT_PATH] as const,
      )
      await page.evaluate(() => {
        void window.__E2E__!.runCommand('workbench.action.agent.newSession')
      })
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount()), { timeout: 10000 })
        .toBe(1)

      // The echo agent streams an image block back into the timeline.
      await page.evaluate(() => window.__E2E__!.sendAcpPrompt('emit-image:1x1'))
      const image = page.locator('[data-testid="acp-image-block"]').last()
      await expect(image).toBeVisible({ timeout: 10000 })

      // Clobber the clipboard so the later image read can't see stale content.
      await electronApp.evaluate(({ clipboard }) => clipboard.writeText('sentinel'))

      await image.click({ button: 'right' })
      const item = page.getByRole('menuitem', { name: 'Copy Image' })
      await expect(item).toBeVisible({ timeout: 3000 })
      await item.click()

      await expect
        .poll(() => electronApp.evaluate(({ clipboard }) => !clipboard.readImage().isEmpty()), {
          timeout: 5000,
        })
        .toBe(true)
    },
  )

  test(
    'right-clicking a prompt attachment chip offers Copy Image and writes the clipboard @regression',
    { tag: '@serial' },
    async ({ page, electronApp, workbench }) => {
      await workbench.waitForRestored()

      await page.evaluate(
        ([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p, { ECHO_AGENT_IMAGE: '1' }),
        ['echo', ECHO_AGENT_PATH] as const,
      )
      await page.evaluate(() => {
        void window.__E2E__!.runCommand('workbench.action.agent.newSession')
      })
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount()), { timeout: 10000 })
        .toBe(1)
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getActiveAcpSessionImageSupported()), {
          timeout: 10000,
        })
        .toBe(true)

      // Attach an image chip through the real paste path.
      await electronApp.evaluate(({ clipboard, nativeImage }, b64) => {
        const img = nativeImage.createFromBuffer(Buffer.from(b64, 'base64'))
        if (img.isEmpty()) throw new Error('Failed to create test nativeImage')
        clipboard.writeImage(img)
      }, PNG_BASE64)
      await page.evaluate(
        () => void window.__E2E__!.runCommand('workbench.action.agent.focusInput'),
      )
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getContextKey('editorTextFocus')), {
          timeout: 5000,
        })
        .toBe(true)
      await page.keyboard.press('Control+V')
      const chip = page.locator('[data-testid="acp-prompt-image-chip"]').first()
      await expect(chip).toBeVisible({ timeout: 5000 })

      // Clobber the clipboard so the later image read proves the copy action ran.
      await electronApp.evaluate(({ clipboard }) => clipboard.writeText('sentinel'))
      expect(await electronApp.evaluate(({ clipboard }) => clipboard.readImage().isEmpty())).toBe(
        true,
      )

      await chip.click({ button: 'right' })
      const item = page.getByRole('menuitem', { name: 'Copy Image' })
      await expect(item).toBeVisible({ timeout: 3000 })
      await item.click()

      await expect
        .poll(() => electronApp.evaluate(({ clipboard }) => !clipboard.readImage().isEmpty()), {
          timeout: 5000,
        })
        .toBe(true)
    },
  )

  test(
    'right-clicking the image inside the sticky first user message offers Copy Image @regression',
    { tag: '@serial' },
    async ({ page, electronApp, workbench }) => {
      await workbench.waitForRestored()

      await page.evaluate(
        ([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p, { ECHO_AGENT_IMAGE: '1' }),
        ['echo', ECHO_AGENT_PATH] as const,
      )
      await page.evaluate(() => {
        void window.__E2E__!.runCommand('workbench.action.agent.newSession')
      })
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount()), { timeout: 10000 })
        .toBe(1)
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getActiveAcpSessionImageSupported()), {
          timeout: 10000,
        })
        .toBe(true)

      // Paste an image chip, then submit for real so the first user message
      // carries an image block — it renders in the StickyUserMessageBar copy
      // above the scroll container, which owns its own context-menu handler.
      await electronApp.evaluate(({ clipboard, nativeImage }, b64) => {
        const img = nativeImage.createFromBuffer(Buffer.from(b64, 'base64'))
        if (img.isEmpty()) throw new Error('Failed to create test nativeImage')
        clipboard.writeImage(img)
      }, PNG_BASE64)
      await page.evaluate(
        () => void window.__E2E__!.runCommand('workbench.action.agent.focusInput'),
      )
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getContextKey('editorTextFocus')), {
          timeout: 5000,
        })
        .toBe(true)
      await page.keyboard.press('Control+V')
      await expect(page.locator('[data-testid="acp-prompt-image-chip"]').first()).toBeVisible({
        timeout: 5000,
      })
      await page.keyboard.type('look at this')
      await page.keyboard.press('Enter')

      const stickyImage = page.locator(
        '[data-testid="acp-user-bar"] [data-testid="acp-image-block"]',
      )
      await expect(stickyImage).toBeVisible({ timeout: 10000 })

      await electronApp.evaluate(({ clipboard }) => clipboard.writeText('sentinel'))

      await stickyImage.click({ button: 'right' })
      const item = page.getByRole('menuitem', { name: 'Copy Image' })
      await expect(item).toBeVisible({ timeout: 3000 })
      await item.click()

      await expect
        .poll(() => electronApp.evaluate(({ clipboard }) => !clipboard.readImage().isEmpty()), {
          timeout: 5000,
        })
        .toBe(true)
    },
  )

  test(
    'right-clicking a dropped (non-PNG) attachment chip copies the image @regression',
    { tag: '@serial' },
    async ({ page, electronApp, workbench }) => {
      await workbench.waitForRestored()

      await page.evaluate(
        ([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p, { ECHO_AGENT_IMAGE: '1' }),
        ['echo', ECHO_AGENT_PATH] as const,
      )
      await page.evaluate(() => {
        void window.__E2E__!.runCommand('workbench.action.agent.newSession')
      })
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount()), { timeout: 10000 })
        .toBe(1)
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getActiveAcpSessionImageSupported()), {
          timeout: 10000,
        })
        .toBe(true)

      // Drag-and-drop keeps the file's real MIME (unlike paste, which always
      // lands as PNG via the OS clipboard) — synthesize a JPEG file drop so the
      // chip's data URI is image/jpeg.
      await page.evaluate(() => {
        const canvas = document.createElement('canvas')
        canvas.width = 4
        canvas.height = 4
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('2d context unavailable')
        ctx.fillStyle = '#ff0000'
        ctx.fillRect(0, 0, 4, 4)
        const dataUrl = canvas.toDataURL('image/jpeg')
        const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
        const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))
        const file = new File([bytes], 'drop.jpg', { type: 'image/jpeg' })
        const dt = new DataTransfer()
        dt.items.add(file)
        const host = document.querySelector('[data-testid="acp-prompt-drop-host"]')
        if (!host) throw new Error('prompt drop host not found')
        host.dispatchEvent(
          new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }),
        )
      })
      const chip = page.locator('[data-testid="acp-prompt-image-chip"]').first()
      await expect(chip).toBeVisible({ timeout: 5000 })
      expect(await chip.getAttribute('src')).toMatch(/^data:image\/jpeg;base64,/)

      // Clobber the clipboard so the later image read proves the copy action ran.
      await electronApp.evaluate(({ clipboard }) => clipboard.writeText('sentinel'))

      await chip.click({ button: 'right' })
      const item = page.getByRole('menuitem', { name: 'Copy Image' })
      await expect(item).toBeVisible({ timeout: 3000 })
      await item.click()

      await expect
        .poll(() => electronApp.evaluate(({ clipboard }) => !clipboard.readImage().isEmpty()), {
          timeout: 5000,
        })
        .toBe(true)
    },
  )
})
