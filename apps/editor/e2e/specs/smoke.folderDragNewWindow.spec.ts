/*---------------------------------------------------------------------------------------------
 *  Dropping a folder onto the editor tab bar opens it in a NEW window (one per
 *  folder), rather than failing to open it as an editor. Files keep opening as
 *  editors. Multi-window state lives in the main-process IWindowsService, so we
 *  drive a real drop and assert a second window appears.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, expect } from '../fixtures/electronApp.js'
import { expectNoLeaks, evaluateWhenRestored } from '../pages/WorkbenchPO.js'

test.describe('@p1 folder drag → new window', () => {
  // @serial: this case cold-launches its own Electron, opens a workspace (root),
  // then drops a folder to spawn a SECOND window loading another workspace (sub)
  // — two parcel watcher subscribes back-to-back on the main process. @parcel/
  // watcher's windows backend has a cross-process native race: when several
  // Electron instances (e2e workers) subscribe concurrently it can fault
  // (0xC0000005) the main process, surfacing here as "Target page has been
  // closed". Single-instance runs never trip it, so pin to one worker (same
  // root cause as smoke.simpleFileDialog). See `pnpm e2e` (serial pass).
  test(
    'dropping a folder on the tab bar opens it in a new window',
    { tag: '@serial' },
    async ({ electronApp, workbench, page }) => {
      await workbench.waitForRestored()

      const root = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-foldrop-'))
      const sub = join(root, 'sub')
      mkdirSync(sub)
      writeFileSync(join(root, 'a.ts'), 'x')
      const rootFs = root.replace(/\\/g, '/')
      const subFs = sub.replace(/\\/g, '/')

      await workbench.openWorkspace(root)
      // Open a file so the tab bar is rendered.
      await page.evaluate((p) => window.__E2E__!.openFileUri(p), `${rootFs}/a.ts`)
      const tabBar = page.locator('[data-testid="editor-group-tabbar"]')
      await expect(tabBar).toBeVisible({ timeout: 5000 })

      const newWindow = electronApp.waitForEvent('window')
      await page.evaluate((uri) => {
        const bar = document.querySelector<HTMLElement>('[data-testid="editor-group-tabbar"]')!
        const dt = new DataTransfer()
        dt.setData('text/uri-list', uri)
        dt.setData('application/vnd.universe-editor.uri-list', uri)
        const fire = (type: string): void => {
          const r = bar.getBoundingClientRect()
          bar.dispatchEvent(
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
      }, pathToFileURL(sub).href)

      const newPage = await newWindow
      await newPage.waitForFunction(() =>
        Boolean((window as unknown as Record<string, unknown>)['__E2E__']),
      )
      await evaluateWhenRestored(newPage)
      await expect
        .poll(() => newPage.evaluate(() => window.__E2E__!.getCurrentWorkspacePath()), {
          timeout: 8000,
        })
        .toBe(subFs)

      await expectNoLeaks(newPage)
    },
  )
})
