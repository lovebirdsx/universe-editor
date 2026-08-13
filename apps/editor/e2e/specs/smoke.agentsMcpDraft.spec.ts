/*---------------------------------------------------------------------------------------------
 *  Session MCP reload preserves the unsent prompt draft (@p1).
 *
 *  Repro: type into the session prompt input (or paste an image) without
 *  sending, then toggle an MCP server. The seamless reload closes the session
 *  and swaps in a replacement (empty session) or a resumed one (messaged
 *  session). The draft cache is keyed by session id and closeSession wipes it,
 *  so the remounted prompt input came back empty — the user's half-typed text
 *  and pasted images were lost. The fix rescues the draft before closeSession
 *  and re-seeds it under the new session's id BEFORE the replacement session is
 *  registered/activated, so the remount restores it.
 *
 *  Assertions read BOTH the draft cache (getAcpPromptText) and the visible
 *  Monaco view (getAcpVisiblePromptText): a cache seeded after the remount
 *  would satisfy the former while the editor still renders empty.
 *--------------------------------------------------------------------------------------------*/

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/sharedApp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')

// 2×2 red PNG.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAE0lEQVR4AWP8z8DwnwEImBigAAAfFwICgH3ifwAAAABJRU5ErkJggg=='

async function setupEchoSession(page: Page, env?: Record<string, string>) {
  await page.evaluate(() =>
    window.__E2E__!.updateConfigValue('acp.mcpServers', {
      web: { command: 'node', args: ['-e', ''] },
    }),
  )
  // Default-disabled at the user (GLOBAL) scope — the session starts without
  // the server until the picker explicitly enables it.
  await page.evaluate(() => window.__E2E__!.setAcpMcpServerEnabled('web', false))
  await page.evaluate(([id, p, e]) => window.__E2E__!.installAcpEchoAgent(id, p, e), [
    'echo',
    ECHO_AGENT_PATH,
    env ?? { ECHO_AGENT_LOAD_SESSION: '1' },
  ] as const)
  await page.evaluate(() => {
    void window.__E2E__!.runCommand('workbench.action.agent.newSession')
  })
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionStatus()), { timeout: 10000 })
    .toBe('idle')
  // Session idle flips before the PromptInput's Monaco has mounted — without
  // waiting for the host, focusInput + keystrokes race the mount and get
  // dropped (mirrors smoke.agentsPromptHistory).
  await expect(page.getByTestId('acp-prompt-drop-host')).toBeVisible({ timeout: 10000 })
}

async function typeDraft(page: Page, text: string): Promise<void> {
  await page.evaluate(() => void window.__E2E__!.runCommand('workbench.action.agent.focusInput'))
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getContextKey('acpPromptInputFocused')), {
      timeout: 5000,
    })
    .toBe(true)
  // A small per-key delay keeps the keystrokes from racing the focus switch
  // into the freshly-mounted Monaco (a burst of type() can land before the
  // EditContext is ready and drop the tail of the text).
  await page.keyboard.type(text, { delay: 20 })
  await expect.poll(() => page.evaluate(() => window.__E2E__!.getAcpPromptText())).toBe(text)
  await expect.poll(() => page.evaluate(() => window.__E2E__!.getAcpVisiblePromptText())).toBe(text)
}

async function toggleMcpAndWaitReload(page: Page, beforeId: string | undefined): Promise<void> {
  await page.evaluate(() => window.__E2E__!.setAcpSessionMcpServers(['web']))
  await expect
    .poll(
      async () => {
        const status = await page.evaluate(() => window.__E2E__!.getAcpSessionStatus())
        const id = await page.evaluate(() => window.__E2E__!.getActiveAcpSessionId())
        return status === 'idle' && id !== undefined && id !== beforeId
      },
      { timeout: 15000 },
    )
    .toBe(true)
}

async function expectDraftRestored(page: Page, text: string): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getAcpVisiblePromptText()), {
      timeout: 10000,
    })
    .toBe(text)
  await expect.poll(() => page.evaluate(() => window.__E2E__!.getAcpPromptText())).toBe(text)
}

test.describe('@p1 agents MCP reload preserves prompt draft', () => {
  test('text draft survives the reload of an empty session @regression', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()
    // A late one-shot bootstrap focus restore would steal focus to the Explorer
    // tree mid-typing (only the first keystroke lands), so gate before driving
    // the prompt input.
    await workbench.waitForBootstrapFocusSettled()
    await setupEchoSession(page)
    await typeDraft(page, 'draft survives reload')

    const beforeId = await page.evaluate(() => window.__E2E__!.getActiveAcpSessionId())
    await toggleMcpAndWaitReload(page, beforeId)

    await expectDraftRestored(page, 'draft survives reload')
  })

  test('text draft survives the session/load reload of a messaged session @regression', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    await setupEchoSession(page)

    // Give the session real content so the reload takes the session/load path.
    await page.evaluate(() => window.__E2E__!.sendAcpPrompt('hello'))
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpMessages()), { timeout: 5000 })
      .toEqual([
        { role: 'user', text: 'hello' },
        { role: 'agent', text: 'echo: hello' },
      ])

    await typeDraft(page, 'follow-up in progress')
    const beforeId = await page.evaluate(() => window.__E2E__!.getActiveAcpSessionId())
    await toggleMcpAndWaitReload(page, beforeId)

    await expectDraftRestored(page, 'follow-up in progress')
  })

  // @serial: seeds the OS clipboard — a global resource. Another worker writing
  // the clipboard concurrently (smoke.acpPasteImage) races this test's
  // write→paste sequence and flakes both.
  test(
    'a pasted image attachment survives the reload @regression',
    { tag: '@serial' },
    async ({ page, electronApp, workbench }) => {
      await workbench.waitForRestored()
      await workbench.waitForBootstrapFocusSettled()
      await setupEchoSession(page, { ECHO_AGENT_IMAGE: '1' })
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getActiveAcpSessionImageSupported()), {
          timeout: 10000,
        })
        .toBe(true)

      // Seed the OS clipboard with a PNG and paste it for real.
      await electronApp.evaluate(({ clipboard, nativeImage }, b64) => {
        const img = nativeImage.createFromBuffer(Buffer.from(b64, 'base64'))
        if (img.isEmpty()) throw new Error('Failed to create test nativeImage')
        clipboard.writeImage(img)
      }, PNG_BASE64)
      await page.evaluate(
        () => void window.__E2E__!.runCommand('workbench.action.agent.focusInput'),
      )
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getContextKey('acpPromptInputFocused')), {
          timeout: 5000,
        })
        .toBe(true)
      await page.keyboard.press('Control+V')
      await expect(page.locator('[data-testid="acp-prompt-image-chips"]')).toBeVisible({
        timeout: 5000,
      })

      const beforeId = await page.evaluate(() => window.__E2E__!.getActiveAcpSessionId())
      await toggleMcpAndWaitReload(page, beforeId)

      // The replacement session must re-render the attached image chip.
      await expect(page.locator('[data-testid="acp-prompt-image-chips"]')).toBeVisible({
        timeout: 10000,
      })
    },
  )
})
