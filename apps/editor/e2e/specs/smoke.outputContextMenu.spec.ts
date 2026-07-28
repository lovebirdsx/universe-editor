/*---------------------------------------------------------------------------------------------
 *  Output-panel right-click after a diff editor closed (@p1).
 *
 *  Repro for "InstantiationService has been disposed" when right-clicking the
 *  Output panel. Monaco keeps ONE global hover-delegate factory; each
 *  StandaloneCodeEditor constructor overwrites it with a closure over the
 *  IInstantiationService it was built with. Diff editors are built from a
 *  per-widget child that dies with the widget, so once a diff editor is
 *  disposed the factory dangles and the next context menu anywhere (Menu →
 *  ActionBar → createInstantHoverDelegate) throws.
 *
 *  Sequence matters: the Output editor must exist BEFORE the diff editor —
 *  creating a plain editor afterwards would reseat the factory onto the root
 *  service and mask the bug.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '../fixtures/sharedApp.js'

const LEFT_CONTENT = 'left file\nalpha\nbeta\ngamma'
const RIGHT_CONTENT = 'right file\ndelta\nepsilon\nzeta'

function fsPathToUriComponents(fsPath: string) {
  const forwardSlash = fsPath.replace(/\\/g, '/')
  const path = forwardSlash.startsWith('/') ? forwardSlash : '/' + forwardSlash
  return { scheme: 'file', authority: '', path, query: '', fragment: '' }
}

test.describe('@p1 output context menu', () => {
  test('right-click works after a diff editor was created and closed', async ({ workbench }) => {
    const dir = mkdtempSync(join(tmpdir(), 'ue2-outputctx-'))
    const leftPath = join(dir, 'left.txt')
    const rightPath = join(dir, 'right.txt')
    writeFileSync(leftPath, LEFT_CONTENT, 'utf8')
    writeFileSync(rightPath, RIGHT_CONTENT, 'utf8')

    const page = workbench.page
    const disposedErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.text().includes('InstantiationService has been disposed')) {
        disposedErrors.push(msg.text())
      }
    })

    await workbench.waitForRestored()
    await workbench.openWorkspace(dir)

    // 1. Mount the Output editor first: an error log reveals the panel with the
    //    'Renderer' channel active and gives it content.
    await page.evaluate(() => {
      window.__E2E__!.triggerUnexpectedError('E2E hover guard repro')
    })
    await workbench.panel.waitForVisible()
    const outputLines = page.getByTestId('part-panel').locator('.monaco-editor .view-lines')
    await expect(outputLines).toBeAttached({ timeout: 10_000 })

    // 2. Open a diff editor — its inner editors reseat the global hover factory
    //    onto the diff widget's child IInstantiationService.
    await workbench.runCommand('selectForCompare', {
      target: fsPathToUriComponents(leftPath),
    })
    await workbench.runCommand('compareSelected', {
      target: fsPathToUriComponents(rightPath),
    })
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveDiffContent()), {
        timeout: 10_000,
      })
      .toBeTruthy()

    // 3. Close the diff editor. The widget and its child instantiation service
    //    die here; without the hover-guard reset the global factory dangles.
    await workbench.runCommand('workbench.action.closeActiveEditor')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveDiffContent() == null), {
        timeout: 10_000,
      })
      .toBe(true)

    // 4. Right-click the Output text — the context menu must render. The panel
    //    relayouts after the last editor tab closes; give the output editor a
    //    beat to settle before dispatching the click.
    await page.waitForTimeout(1000)
    await outputLines.click({ button: 'right' })
    await expect(page.locator('.context-view .monaco-menu')).toBeVisible({ timeout: 10_000 })
    expect(disposedErrors).toEqual([])

    await page.keyboard.press('Escape')
  })
})
