/*---------------------------------------------------------------------------------------------
 *  Find in the Output panel (Ctrl+F).
 *
 *  The Output log area is a real Monaco editor, so the find widget, its match
 *  count and the case/word/regex toggles are Monaco's own. What the workbench
 *  has to get right is *which* editor the Find commands act on: they must follow
 *  the DOM focus, not the active editor tab. Every assertion therefore reads the
 *  find controller's state through the probe — never the widget's DOM.
 *--------------------------------------------------------------------------------------------*/

import { test, expect } from '../fixtures/sharedApp.js'
import type { Page } from '@playwright/test'

const CHANNEL = 'E2E Find'
/** Lines 0,5,10,15 carry the needle → 4 matches in a 20-line channel. */
const NEEDLE = 'e2e-find-needle'
const EXPECTED_MATCHES = 4

const OUTPUT_VIEW_ID = 'workbench.view.output.main'

async function seedChannel(page: Page): Promise<void> {
  await page.evaluate(
    ({ name, needle }) => {
      window.__E2E__!.createOutputChannel(name)
      // No trailing newline: the model would report an extra empty line and
      // break the exact line count below.
      const text = Array.from(
        { length: 20 },
        (_, i) => `[info] e2e-find-line-${i}${i % 5 === 0 ? ` ${needle}` : ''}`,
      ).join('\n')
      window.__E2E__!.appendToOutputChannel(name, text)
      window.__E2E__!.setActiveOutputChannel(name)
    },
    { name: CHANNEL, needle: NEEDLE },
  )
  // Monaco mounts the log editor asynchronously (dynamic import).
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getVisibleOutputLines().length), {
      timeout: 15_000,
    })
    .toBe(20)
}

/** Show the Output panel, focus its editor and settle any leftover find widget. */
async function focusOutput(page: Page): Promise<void> {
  await page.evaluate(() => window.__E2E__!.focusOutputView())
  // `focusedView` — not `editorFocus` — is what proves focus landed in the panel:
  // with a file editor open `editorFocus` is already true, so polling it alone
  // would let Ctrl+F be driven from the editor group and the assertions below
  // would be measuring the wrong surface.
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getContextKey('focusedView')), {
      timeout: 15_000,
    })
    .toBe(OUTPUT_VIEW_ID)
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getContextKey('editorFocus')))
    .toBe(true)
  await page.keyboard.press('Escape')
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getOutputFindState()?.isRevealed))
    .toBe(false)
}

test.describe('output find', () => {
  test.afterEach(async ({ page }) => {
    await page.evaluate(() => {
      window.__E2E__!.setOutputFilterText('')
      window.__E2E__!.setOutputHiddenLevels([])
    })
  })

  test('Ctrl+F opens the find widget on the Output editor with live match counts @p0', async ({
    workbench,
    page,
  }) => {
    await workbench.waitForRestored()
    // The one-shot startup focus restore lands after LifecyclePhase.Restored and
    // would otherwise yank focus out of the panel mid-test.
    await workbench.waitForBootstrapFocusSettled()
    await seedChannel(page)
    await focusOutput(page)

    await page.keyboard.press('ControlOrMeta+f')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getOutputFindState()?.isRevealed), {
        timeout: 10_000,
      })
      .toBe(true)

    await page.keyboard.type(NEEDLE)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getOutputFindState()?.matchesCount))
      .toBe(EXPECTED_MATCHES)
    const first = await page.evaluate(
      () => window.__E2E__!.getOutputFindState()?.currentMatch ?? null,
    )

    await page.keyboard.press('F3')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getOutputFindState()?.currentMatch ?? null))
      .not.toBe(first)

    // Escape closes the widget and must leave focus in the panel — the global
    // Escape binding (`!editorFocus`) is what used to steal it for the editor
    // group, leaving the widget open behind a de-focused panel.
    await page.keyboard.press('Escape')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getOutputFindState()?.isRevealed))
      .toBe(false)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getContextKey('focusedView')))
      .toBe(OUTPUT_VIEW_ID)
  })

  test('Ctrl+F in the Output panel never opens the file editor’s find widget @regression', async ({
    workbench,
    page,
  }) => {
    await workbench.waitForRestored()
    // The one-shot startup focus restore lands after LifecyclePhase.Restored and
    // would otherwise yank focus out of the panel mid-test.
    await workbench.waitForBootstrapFocusSettled()
    // An open editor is what made the Find actions resolve to the editor group:
    // `hasActiveEditor` was true and the active editor was this untitled buffer.
    await workbench.runCommand('workbench.action.files.newUntitledFile')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getFileEditorFindState() !== undefined), {
        timeout: 15_000,
      })
      .toBe(true)

    await seedChannel(page)
    await focusOutput(page)

    await page.keyboard.press('ControlOrMeta+f')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getOutputFindState()?.isRevealed), {
        timeout: 10_000,
      })
      .toBe(true)
    expect(
      await page.evaluate(() => window.__E2E__!.getFileEditorFindState()?.isRevealed),
    ).not.toBe(true)
  })

  test('Ctrl+H is a no-op in the read-only Output log @p1', async ({ workbench, page }) => {
    await workbench.waitForRestored()
    // The one-shot startup focus restore lands after LifecyclePhase.Restored and
    // would otherwise yank focus out of the panel mid-test.
    await workbench.waitForBootstrapFocusSettled()
    await workbench.runCommand('workbench.action.files.newUntitledFile')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getFileEditorFindState() !== undefined), {
        timeout: 15_000,
      })
      .toBe(true)

    await seedChannel(page)
    await focusOutput(page)

    await page.keyboard.press('ControlOrMeta+h')
    // Nothing to poll for — a no-op is asserted by staying put, so give the
    // keystroke a beat to reach whichever editor the workbench picked.
    await page.waitForTimeout(300)
    expect(await page.evaluate(() => window.__E2E__!.getOutputFindState()?.isRevealed)).not.toBe(
      true,
    )
    expect(
      await page.evaluate(() => window.__E2E__!.getFileEditorFindState()?.isRevealed),
    ).not.toBe(true)
  })
})
