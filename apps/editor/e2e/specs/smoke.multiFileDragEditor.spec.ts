/*---------------------------------------------------------------------------------------------
 *  Regression: dragging multiple files onto the editor must open one editor per
 *  file — not just the first. Covers both an OS file drag (real OS-backed File
 *  objects) and a CR-only separated `text/uri-list`, the shape that previously
 *  collapsed into a single (garbled) resource so only one editor opened.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import { test, expect } from '../fixtures/sharedApp.js'

async function tryCleanup(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    /* the workspace watcher may still hold the dir on Windows; OS reaps tmp */
  }
}

test.describe('@p1 multi-file drag → editor', () => {
  test('OS file drag opens one editor per file @regression', async ({ page, workbench }) => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ue2-mfe-'))
    const names = ['aaa.txt', 'bbb.txt', 'ccc.txt']
    const files = await Promise.all(
      names.map(async (n) => {
        const p = path.join(tmpDir, n)
        await fs.writeFile(p, 'x')
        return p
      }),
    )

    await workbench.waitForRestored()
    await workbench.openWorkspace(tmpDir)

    const editorBody = page.locator('[data-testid="editor-group-body"]').first()
    await expect(editorBody).toBeVisible({ timeout: 5000 })
    const editorTabs = page.locator('[data-testid="editor-group-tabbar"] [role="tab"]')

    await page.evaluate(() => {
      const input = document.createElement('input')
      input.type = 'file'
      input.multiple = true
      input.id = '__diag_file_input__'
      input.style.cssText = 'position:fixed;left:-9999px'
      document.body.appendChild(input)
    })
    await page.setInputFiles('#__diag_file_input__', files)

    await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>('#__diag_file_input__')!
      const body = document.querySelector<HTMLElement>('[data-testid="editor-group-body"]')!
      const dt = new DataTransfer()
      for (const f of Array.from(input.files ?? [])) dt.items.add(f)
      const fire = (type: string): void => {
        const r = body.getBoundingClientRect()
        body.dispatchEvent(
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
      input.remove()
    })

    await expect.poll(() => editorTabs.count(), { timeout: 5000 }).toBe(3)

    await tryCleanup(tmpDir)
  })

  test('a CR-separated text/uri-list opens one editor per file @regression', async ({
    page,
    workbench,
  }) => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ue2-mfecr-'))
    const names = ['aaa.txt', 'bbb.txt', 'ccc.txt']
    await Promise.all(names.map((n) => fs.writeFile(path.join(tmpDir, n), 'x')))

    await workbench.waitForRestored()
    await workbench.openWorkspace(tmpDir)

    const editorBody = page.locator('[data-testid="editor-group-body"]').first()
    await expect(editorBody).toBeVisible({ timeout: 5000 })
    const editorTabs = page.locator('[data-testid="editor-group-tabbar"] [role="tab"]')

    const root = tmpDir.replace(/\\/g, '/')
    await page.evaluate(
      ([rootDir, fileNames]) => {
        const body = document.querySelector<HTMLElement>('[data-testid="editor-group-body"]')!
        const dt = new DataTransfer()
        dt.setData('text/uri-list', fileNames.map((n) => `file:///${rootDir}/${n}`).join('\r'))
        const fire = (type: string): void => {
          const r = body.getBoundingClientRect()
          body.dispatchEvent(
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
      [root, names] as const,
    )

    await expect.poll(() => editorTabs.count(), { timeout: 5000 }).toBe(3)

    await tryCleanup(tmpDir)
  })

  // The exact in-app Explorer → editor bug: on a real drag the OS round-trips a
  // multi-entry text/uri-list into a single glued line, but our private mirror
  // (application/vnd.universe-editor.uri-list) survives and must be preferred.
  test('a glued text/uri-list still opens every file via the private mirror @regression', async ({
    page,
    workbench,
  }) => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ue2-mfeglue-'))
    const names = ['aaa.txt', 'bbb.txt', 'World负载均衡设计方案.md']
    await Promise.all(names.map((n) => fs.writeFile(path.join(tmpDir, n), 'x')))

    await workbench.waitForRestored()
    await workbench.openWorkspace(tmpDir)

    const editorBody = page.locator('[data-testid="editor-group-body"]').first()
    await expect(editorBody).toBeVisible({ timeout: 5000 })
    const editorTabs = page.locator('[data-testid="editor-group-tabbar"] [role="tab"]')

    const root = tmpDir.replace(/\\/g, '/')
    await page.evaluate(
      ([rootDir, fileNames]) => {
        const body = document.querySelector<HTMLElement>('[data-testid="editor-group-body"]')!
        const uris = fileNames.map((n) => `file:///${rootDir}/${encodeURIComponent(n)}`)
        const dt = new DataTransfer()
        // Standard wire format glued into one line (the OS corruption)...
        dt.setData('text/uri-list', uris.join(''))
        // ...but the private mirror round-trips intact.
        dt.setData('application/vnd.universe-editor.uri-list', uris.join('\n'))
        const fire = (type: string): void => {
          const r = body.getBoundingClientRect()
          body.dispatchEvent(
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
      [root, names] as const,
    )

    await expect.poll(() => editorTabs.count(), { timeout: 5000 }).toBe(3)

    await tryCleanup(tmpDir)
  })
})
