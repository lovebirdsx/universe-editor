/*---------------------------------------------------------------------------------------------
 *  Regression: a markdown preview in an auxiliary window must keep its own
 *  keyboard focus when the same source's preview is (re)mounted in the main
 *  window last.
 *
 *  Before the fix, `MarkdownPreviewRegistry` was keyed by source URI only and
 *  `MarkdownPreviewInput.focus()` resolved the last registered controller; the
 *  main window's remount therefore stole the auxiliary window's focus request,
 *  leaving focus on its tab and making j/k (a listener on the preview root) dead.
 *--------------------------------------------------------------------------------------------*/

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkTempDir } from '@universe-editor/e2e-harness'
import { test, expect } from '../fixtures/coreMarkdownApp.js'
import { activateMainWindow, waitForAuxWindow } from './helpers/auxiliaryWindow.js'

function seedMarkdown(name: string, content: string): string {
  const dir = mkTempDir('universe-editor-e2e-preview-aux-focus-')
  const path = join(dir, name)
  writeFileSync(path, content)
  return path.replace(/\\/g, '/')
}

function longMarkdown(): string {
  const blocks: string[] = ['# Long document', '']
  for (let i = 1; i <= 200; i++) {
    blocks.push(`## Section ${i}`, '', `Paragraph ${i} ${'lorem ipsum '.repeat(20)}`, '')
  }
  return blocks.join('\n')
}

test.describe('@p1 markdown preview — auxiliary window focus', () => {
  test('j scrolls the auxiliary preview after the main preview remounts last @regression', async ({
    electronApp,
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()

    const longDoc = seedMarkdown('long-doc.md', longMarkdown())
    const otherDoc = seedMarkdown('other.md', '# Other\n\nNothing to see.\n')

    // Preview in the main window, then clone it into a new window.
    await page.evaluate((fsPath) => window.__E2E__!.openFileUri(fsPath), longDoc)
    await workbench.runCommand('workbench.action.markdown.openPreview')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), { timeout: 10_000 })
      .toBe('markdown.preview')

    const child = await waitForAuxWindow(
      electronApp,
      workbench,
      'workbench.action.copyEditorToNewWindow',
    )
    await expect(child.locator('[data-testid="markdown-preview"]')).toBeVisible({
      timeout: 10_000,
    })

    // Remount the main preview LAST: switch to another tab, then back. Copying
    // into the new window moved the open target there, so route opens back to
    // the main part first.
    await activateMainWindow(page)
    await page.evaluate((fsPath) => window.__E2E__!.openFileUri(fsPath), otherDoc)
    await expect(page.locator('[data-testid="markdown-preview"]')).toHaveCount(0)
    await page
      .locator('[data-testid="editor-group-tabbar"] [role="tab"]', {
        hasText: 'Preview long-doc.md',
      })
      .click()
    await expect(page.locator('[data-testid="markdown-preview"]')).toBeVisible()

    // Clicking the auxiliary window's tab must focus ITS preview, not the
    // main window's last-registered one.
    await child.getByRole('tab').first().click()
    await expect
      .poll(() =>
        child.evaluate(() => {
          const preview = document.querySelector('[data-testid="markdown-preview"]')
          return preview !== null && preview.contains(document.activeElement)
        }),
      )
      .toBe(true)

    // And j must actually scroll it (the preview root owns the key listener).
    const scrollTop = () =>
      child.evaluate(
        () =>
          (document.querySelector('[data-testid="markdown-preview"]') as HTMLElement | null)
            ?.scrollTop ?? 0,
      )
    await expect
      .poll(
        async () => {
          if ((await scrollTop()) === 0) await child.keyboard.press('j')
          return scrollTop()
        },
        { timeout: 5000 },
      )
      .toBeGreaterThan(0)
  })
})
