/*---------------------------------------------------------------------------------------------
 *  Prompt-input undo of dropped references (@p1).
 *
 *  Regression: dropping files onto the agent prompt inserts `@`-reference pills
 *  through the prompt-ref tracker, but those insertions used `model.applyEdits`
 *  — which Monaco explicitly keeps OUT of the undo stack — and the trailing
 *  space was a second edit with no undo boundary. Ctrl+Z therefore could not
 *  remove a dropped reference.
 *
 *  These drive the real keyboard path: drop (synthetic DataTransfer) → Ctrl+Z /
 *  Ctrl+Y into the editContext Monaco editor, asserting both the model text and
 *  the range-tracked refs (the pill decoration must come back on redo).
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { mkTempDir } from '@universe-editor/e2e-harness'
import { test, expect } from '../fixtures/sharedApp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')

async function tryCleanup(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    /* leave it for the OS */
  }
}

async function openSessionWithPrompt(
  page: Page,
  workbench: { waitForRestored(): Promise<void>; openWorkspace(p: string): Promise<void> },
  tmpDir: string,
): Promise<void> {
  await workbench.waitForRestored()
  await workbench.openWorkspace(tmpDir)
  await page.evaluate(([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p), [
    'echo',
    ECHO_AGENT_PATH,
  ] as const)
  await page.evaluate(() => void window.__E2E__!.runCommand('workbench.action.agent.openView'))
  await page.evaluate(() => void window.__E2E__!.runCommand('workbench.action.agent.newSession'))
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount()), { timeout: 10000 })
    .toBe(1)
  const prompt = page.getByTestId('acp-prompt-drop-host')
  await expect(prompt).toBeVisible({ timeout: 10000 })
  await expect(prompt.locator('.monaco-editor').first()).toBeVisible({ timeout: 10000 })
}

/** Drop `names` (resolved under `root`) as a text/uri-list, like an internal drag. */
async function dropFiles(page: Page, root: string, names: readonly string[]): Promise<void> {
  const rootDir = root.replace(/\\/g, '/')
  await page.evaluate(
    ([rootDir, names]) => {
      const target = document.querySelector<HTMLElement>('[data-testid="acp-prompt-drop-host"]')!
      const dt = new DataTransfer()
      dt.setData('text/uri-list', names.map((n) => `file:///${rootDir}/${n}`).join('\r\n'))
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
    },
    [rootDir, names] as const,
  )
}

async function focusPrompt(page: Page): Promise<void> {
  await page.evaluate(() => void window.__E2E__!.runCommand('workbench.action.agent.focusInput'))
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getContextKey('acpPromptInputFocused')), {
      timeout: 5000,
    })
    .toBe(true)
}

const promptText = (page: Page): Promise<string> =>
  page.evaluate(() => window.__E2E__!.getAcpPromptText())
const promptRefs = (page: Page): Promise<ReadonlyArray<{ label: string }>> =>
  page.evaluate(() => window.__E2E__!.getAcpPromptRefs())

test.describe('@p1 prompt undo dropped refs', () => {
  test('Ctrl+Z removes a dropped @reference and Ctrl+Y restores its pill', async ({
    page,
    workbench,
  }) => {
    const tmpDir = mkTempDir('ue2-undoref1-')
    await openSessionWithPrompt(page, workbench, tmpDir)

    await dropFiles(page, tmpDir, ['a.txt'])
    await expect.poll(() => promptText(page)).toBe('@a.txt ')
    await expect.poll(() => promptRefs(page)).toHaveLength(1)

    await focusPrompt(page)
    await page.keyboard.press('Control+Z')
    await expect.poll(() => promptText(page)).toBe('')
    await expect.poll(() => promptRefs(page)).toHaveLength(0)

    await page.keyboard.press('Control+Y')
    await expect.poll(() => promptText(page)).toBe('@a.txt ')
    await expect.poll(() => promptRefs(page)).toHaveLength(1)
    expect((await promptRefs(page))[0]!.label).toBe('a.txt')

    await tryCleanup(tmpDir)
  })

  test('one Ctrl+Z removes a whole multi-file drop; Ctrl+Y restores every pill', async ({
    page,
    workbench,
  }) => {
    const tmpDir = mkTempDir('ue2-undoref2-')
    await openSessionWithPrompt(page, workbench, tmpDir)

    await dropFiles(page, tmpDir, ['a.txt', 'b.txt', 'c.txt'])
    await expect.poll(() => promptText(page)).toBe('@a.txt @b.txt @c.txt ')
    await expect.poll(() => promptRefs(page)).toHaveLength(3)

    await focusPrompt(page)
    await page.keyboard.press('Control+Z')
    await expect.poll(() => promptText(page)).toBe('')
    await expect.poll(() => promptRefs(page)).toHaveLength(0)

    await page.keyboard.press('Control+Y')
    await expect.poll(() => promptText(page)).toBe('@a.txt @b.txt @c.txt ')
    await expect.poll(() => promptRefs(page)).toHaveLength(3)

    await tryCleanup(tmpDir)
  })

  test('typing then dropping undoes in two steps, newest first', async ({ page, workbench }) => {
    const tmpDir = mkTempDir('ue2-undoref3-')
    await openSessionWithPrompt(page, workbench, tmpDir)

    await focusPrompt(page)
    await page.keyboard.type('abc')
    await expect.poll(() => promptText(page)).toBe('abc')

    await dropFiles(page, tmpDir, ['a.txt'])
    await expect.poll(() => promptText(page)).toBe('abc@a.txt ')

    await page.keyboard.press('Control+Z')
    await expect.poll(() => promptText(page)).toBe('abc')
    await expect.poll(() => promptRefs(page)).toHaveLength(0)

    await page.keyboard.press('Control+Z')
    await expect.poll(() => promptText(page)).toBe('')

    await tryCleanup(tmpDir)
  })

  test('plain text undo still works when no image-undo binding is active @regression', async ({
    page,
    workbench,
  }) => {
    const tmpDir = mkTempDir('ue2-undoref4-')
    await openSessionWithPrompt(page, workbench, tmpDir)

    await focusPrompt(page)
    await page.keyboard.type('hello')
    await expect.poll(() => promptText(page)).toBe('hello')

    await page.keyboard.press('Control+Z')
    await expect.poll(() => promptText(page)).toBe('')

    await tryCleanup(tmpDir)
  })
})
