/*---------------------------------------------------------------------------------------------
 *  Chat link hints (@p1).
 *
 *  The vimium-style `f` / `F` link hints used to be preview-only. The chat
 *  timeline is a Markdown reading surface too, and it is a Vim `list` surface
 *  (printable keys are swallowed), so it needs both paths covered:
 *   - Vim disabled → the global `workbench.action.markdownPreview.linkHints`
 *     Action2, gated on `markdownLinkHintsAvailable`;
 *   - Vim enabled  → the per-surface `f` keymap (`list.showLinkHints`).
 *  Activating a label is a synthetic click on the real `<a href>`, so the file
 *  link opens through the same pipeline as a pointer click.
 *--------------------------------------------------------------------------------------------*/

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Page } from '@playwright/test'
import { mkTempDir } from '@universe-editor/e2e-harness'
import { test, expect } from '../fixtures/sharedApp.js'
import { setVimEnabled } from '../pages/vimHelpers.js'

const ECHO_AGENT_PATH = join(
  import.meta.dirname,
  '..',
  '..',
  'src',
  'test-fixtures',
  'echoAgent.cjs',
)
const POLL = { timeout: 15000 }

function writeLinkedTarget(): string {
  const dir = mkTempDir('universe-editor-e2e-chat-links-')
  const fsPath = join(dir, 'target.md')
  writeFileSync(fsPath, '# Target\n\nbody\n')
  return pathToFileURL(fsPath).toString()
}

async function startEchoSession(page: Page): Promise<void> {
  await page.evaluate(([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p), [
    'echo',
    ECHO_AGENT_PATH,
  ] as const)
  await page.evaluate(() => {
    void window.__E2E__!.runCommand('workbench.action.agent.newSession')
  })
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), POLL)
    .toBe('acp.session')
  await expect(page.getByTestId('acp-prompt-drop-host')).toBeVisible({ timeout: 10000 })
}

/**
 * Focus the timeline scroll container directly. Clicking a card would risk
 * landing on one of the links under test (the prompt contains a file URL),
 * which would open the target and replace the active chat tab.
 */
async function focusTimeline(page: Page): Promise<void> {
  const timeline = page.locator('[data-testid="acp-timeline"]')
  await expect(timeline).toBeVisible(POLL)
  await page.evaluate(() => {
    // The timeline list is a direct child of the tabIndex={-1} scroll container.
    const el = document.querySelector('[data-testid="acp-timeline"]')?.parentElement
    if (el instanceof HTMLElement) el.focus()
  })
  await expect
    .poll(
      () => page.evaluate(() => window.__E2E__!.getContextKey('markdownLinkHintsAvailable')),
      POLL,
    )
    .toBe(true)
}

/**
 * Press the real `f` until hints render. Re-press only while still hidden: once
 * visible, `f` would be consumed as a filter character.
 */
async function showLinkHints(page: Page): Promise<void> {
  await page.bringToFront()
  await expect
    .poll(
      async () => {
        if (
          await page.evaluate(() =>
            window.__E2E__!.getContextKey('markdownPreviewLinkHintsVisible'),
          )
        ) {
          return true
        }
        await page.keyboard.press('f')
        return page.evaluate(() => window.__E2E__!.getContextKey('markdownPreviewLinkHintsVisible'))
      },
      { timeout: 8000 },
    )
    .toBe(true)
}

test.describe('@p1 chat link hints', () => {
  test('f surfaces hints over chat Markdown links and follows them', async ({
    page,
    workbench,
  }) => {
    test.setTimeout(120_000)
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()

    const targetUri = writeLinkedTarget()
    await startEchoSession(page)
    await page.evaluate((uri) => window.__E2E__!.sendAcpPrompt(`see ${uri} please`), targetUri)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpMessages().length), POLL)
      .toBe(2)

    await test.step('Vim disabled: the global action surfaces and dismisses hints', async () => {
      await focusTimeline(page)
      await showLinkHints(page)
      await expect(page.locator('[data-testid="md-link-hint"]').first()).toBeVisible()

      await page.keyboard.press('Escape')
      await expect
        .poll(() =>
          page.evaluate(() => window.__E2E__!.getContextKey('markdownPreviewLinkHintsVisible')),
        )
        .toBe(false)
    })

    await test.step('Vim enabled: the list surface routes f and the label opens the link', async () => {
      await setVimEnabled(page, true)
      await focusTimeline(page)
      // The timeline registered its own `list:chat:<sessionId>` surface.
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getContextKey('vimSurfaceId')), POLL)
        .toMatch(/^list:chat:/)

      await showLinkHints(page)
      const label = await page.evaluate(
        () =>
          document.querySelector('[data-testid="md-link-hint"]')?.getAttribute('data-link-label') ??
          '',
      )
      expect(label.length).toBeGreaterThan(0)

      await expect
        .poll(
          async () => {
            if (
              await page.evaluate(() =>
                window.__E2E__!.getContextKey('markdownPreviewLinkHintsVisible'),
              )
            ) {
              await page.keyboard.press(label[0]!)
            }
            return page.evaluate(() => window.__E2E__!.getActiveEditorUri())
          },
          { timeout: 8000 },
        )
        .toContain('target.md')

      // Hints must be gone after activation.
      await expect
        .poll(() =>
          page.evaluate(() => window.__E2E__!.getContextKey('markdownPreviewLinkHintsVisible')),
        )
        .toBe(false)
    })
  })
})
