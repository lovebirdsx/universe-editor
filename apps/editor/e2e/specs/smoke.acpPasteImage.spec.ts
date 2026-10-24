/*---------------------------------------------------------------------------------------------
 *  ACP prompt paste-image regression (@p1).
 *
 *  Repro for "pasting an image into the agent prompt input does nothing".
 *
 *  Root cause: Monaco's `editContext: true` binds a Chromium `EditContext` to the
 *  inner `native-edit-context` div. That element — and its DOM ancestors inside
 *  the Monaco tree — never dispatch `paste` to ordinary `addEventListener`
 *  handlers (EditContext owns the input pipeline), so the old handler on the
 *  editor's own container never fired. The paste still propagates (capture phase)
 *  to the React host div *outside* Monaco's DOM, so the fix listens there and
 *  reads the image from the main-process clipboard.
 *
 *  The first test seeds the OS clipboard with a PNG (via the main process),
 *  focuses the prompt editor, does a real Ctrl+V, and asserts an image chip
 *  appears. The undo cases then drive Ctrl+Z / Ctrl+Y through the keyboard: the
 *  attached images live in React state, so they need the dedicated image-undo
 *  stack (services/acp/promptImageUndo.ts) interleaved with Monaco's text
 *  history by alternative version.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkTempDir } from '@universe-editor/e2e-harness'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect } from '../fixtures/sharedApp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')

// 2×2 red PNG.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAE0lEQVR4AWP8z8DwnwEImBigAAAfFwICgH3ifwAAAABJRU5ErkJggg=='

type Workbench = {
  waitForRestored(): Promise<void>
}

/** Echo agent + one live session that advertises image support, prompt focused. */
async function openImageSession(
  page: Page,
  electronApp: ElectronApplication,
  workbench: Workbench,
): Promise<void> {
  await workbench.waitForRestored()

  // Echo agent with image capability so the paste path is not gated off.
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

  await seedClipboard(electronApp)
  await focusPrompt(page)
}

async function seedClipboard(electronApp: ElectronApplication): Promise<void> {
  // Seed the OS clipboard with a PNG via the main-process clipboard module.
  await electronApp.evaluate(({ clipboard, nativeImage }, b64) => {
    const img = nativeImage.createFromBuffer(Buffer.from(b64, 'base64'))
    if (img.isEmpty()) throw new Error('Failed to create test nativeImage')
    clipboard.writeImage(img)
  }, PNG_BASE64)
  expect(await electronApp.evaluate(({ clipboard }) => !clipboard.readImage().isEmpty())).toBe(true)
}

async function focusPrompt(page: Page): Promise<void> {
  await page.evaluate(() => void window.__E2E__!.runCommand('workbench.action.agent.focusInput'))
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getContextKey('acpPromptInputFocused')), {
      timeout: 5000,
    })
    .toBe(true)
}

/** Real Ctrl+V; waits for the pasted image to attach. */
async function pasteImage(page: Page): Promise<void> {
  await page.keyboard.press('Control+V')
  await expect(page.locator('[data-testid="acp-prompt-image-chips"]')).toBeVisible({
    timeout: 5000,
  })
}

const imageChips = (page: Page): ReturnType<Page['locator']> =>
  page.locator('[data-testid="acp-prompt-image-chip"]')
const promptText = (page: Page): Promise<string> =>
  page.evaluate(() => window.__E2E__!.getAcpPromptText())

async function tryCleanup(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    /* leave it for the OS */
  }
}

/** Drop one file as a text/uri-list, like an internal drag from Explorer. */
async function dropFile(page: Page, root: string, name: string): Promise<void> {
  // 同 smoke.promptUndoRef.spec.ts：用 pathToFileURL 避免 POSIX 上的四斜杠 URI。
  const uri = pathToFileURL(resolve(root, name)).href
  await page.evaluate((uri) => {
    const target = document.querySelector<HTMLElement>('[data-testid="acp-prompt-drop-host"]')!
    const dt = new DataTransfer()
    dt.setData('text/uri-list', uri)
    const fire = (type: string): void => {
      const r = target.getBoundingClientRect()
      target.dispatchEvent(
        new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          clientX: r.left + r.width / 2,
          clientY: r.top + r.height / 2,
          dataTransfer: dt,
        }),
      )
    }
    fire('dragenter')
    fire('dragover')
    fire('drop')
  }, uri)
}

test.describe('@p1 acp paste image', () => {
  // @serial: seeds the OS clipboard — a global resource. Another worker writing
  // the clipboard concurrently (smoke.agentsMcpDraft's pasted-image case) races
  // this test's write→read sequence and flakes both.
  test(
    'pasting an image into the prompt attaches it as a chip @regression',
    { tag: '@serial' },
    async ({ page, electronApp, workbench }) => {
      await openImageSession(page, electronApp, workbench)
      await pasteImage(page)
    },
  )

  test(
    'Ctrl+Z removes a pasted image and Ctrl+Y restores it',
    { tag: '@serial' },
    async ({ page, electronApp, workbench }) => {
      await openImageSession(page, electronApp, workbench)
      await pasteImage(page)

      await page.keyboard.press('Control+Z')
      await expect.poll(() => imageChips(page).count()).toBe(0)

      await page.keyboard.press('Control+Y')
      await expect.poll(() => imageChips(page).count()).toBe(1)
      // The image history must not have touched the (empty) text.
      expect(await promptText(page)).toBe('')
    },
  )

  test(
    'image undo runs before text undo when the paste came after typing',
    {
      tag: '@serial',
    },
    async ({ page, electronApp, workbench }) => {
      await openImageSession(page, electronApp, workbench)
      await page.keyboard.type('hello')
      await expect.poll(() => promptText(page)).toBe('hello')

      await pasteImage(page)
      // Attach at the current text version: the first Ctrl+Z consumes the image
      // and leaves the text alone, the second one reaches Monaco's history.
      await page.keyboard.press('Control+Z')
      await expect.poll(() => imageChips(page).count()).toBe(0)
      expect(await promptText(page)).toBe('hello')

      await page.keyboard.press('Control+Z')
      await expect.poll(() => promptText(page)).toBe('')
    },
  )

  test(
    'a fresh edit invalidates the image redo branch',
    { tag: '@serial' },
    async ({ page, electronApp, workbench }) => {
      await openImageSession(page, electronApp, workbench)
      await pasteImage(page)

      await page.keyboard.press('Control+Z')
      await expect.poll(() => imageChips(page).count()).toBe(0)

      await page.keyboard.type('x')
      await expect.poll(() => promptText(page)).toBe('x')
      await expect
        .poll(() =>
          page.evaluate(() => window.__E2E__!.getContextKey('acpPromptImageRedoAvailable')),
        )
        .toBe(false)

      await page.keyboard.press('Control+Y')
      await expect.poll(() => imageChips(page).count()).toBe(0)
      expect(await promptText(page)).toBe('x')
    },
  )

  test(
    'a ref inserted after the image undoes first, then the image',
    { tag: '@serial' },
    async ({ page, electronApp, workbench }) => {
      const tmpDir = mkTempDir('ue2-imgref-')
      await workbench.waitForRestored()
      await workbench.openWorkspace(tmpDir)
      await openImageSession(page, electronApp, workbench)
      await pasteImage(page)

      await dropFile(page, tmpDir, 'a.txt')
      await expect.poll(() => promptText(page)).toBe('@a.txt ')
      await expect.poll(() => imageChips(page).count()).toBe(1)
      await focusPrompt(page)

      // The ref insert pushed a new undo element, so the image gate must be
      // off: Ctrl+Z undoes the ref (and both key handlers must agree).
      await page.keyboard.press('Control+Z')
      await expect.poll(() => promptText(page)).toBe('')
      await expect.poll(() => imageChips(page).count()).toBe(1)

      await page.keyboard.press('Control+Z')
      await expect.poll(() => imageChips(page).count()).toBe(0)

      await tryCleanup(tmpDir)
    },
  )
})
