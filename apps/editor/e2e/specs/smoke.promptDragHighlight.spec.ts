/*---------------------------------------------------------------------------------------------
 *  Regression: dragging a resource over a full-screen agent session lights the
 *  editor group's blue "drop here" overlay AND the prompt input's outline. Two
 *  things must hold once the gesture ends:
 *    1. While the pointer is over the prompt input, the surrounding editor group
 *       overlay must NOT glow — the input owns that drop.
 *    2. After the drop / cancel, the editor group overlay must clear. A drop on
 *       the input (whose handler stopPropagation()s) or an Esc-cancel never
 *       delivers a drop/leave to the body, so a naive handler leaves it stuck.
 *
 *  Playwright can't produce native HTML5 DnD, so we synthesize the event
 *  sequence: light the overlay by dragging over the body, then end the gesture
 *  via a window-level `dragend` (Esc-cancel / release elsewhere) that never
 *  reaches the body — the exact shape that left the overlay stuck.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
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

// Open a session as a FULL-SCREEN editor so the prompt input is hosted inside an
// editor group body — the layout where the overlays coexist and collide.
async function openSessionInEditor(
  page: import('@playwright/test').Page,
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
  await page.evaluate(() => void window.__E2E__!.runCommand('workbench.action.agent.openInEditor'))
  const host = page.getByTestId('acp-prompt-drop-host')
  await expect(host).toBeVisible({ timeout: 10000 })
}

function overlayVisible(page: import('@playwright/test').Page): Promise<boolean> {
  return page.evaluate(
    () => document.querySelector('[data-testid="editor-group-drop-overlay"]') !== null,
  )
}

test.describe('@p1 session editor drag overlay', () => {
  test('editor overlay stops glowing once the pointer moves onto the prompt input', async ({
    page,
    workbench,
  }) => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ue2-sedo-'))
    await fs.writeFile(path.join(tmpDir, 'a.txt'), 'x')
    await openSessionInEditor(page, workbench, tmpDir)

    const uri = `file:///${tmpDir.replace(/\\/g, '/')}/a.txt`

    // Phase 1: drag over the chat area (body, above the input) → overlay lights.
    await page.evaluate((fileUri) => {
      const dt = new DataTransfer()
      dt.setData('text/uri-list', fileUri)
      dt.setData('application/vnd.universe-editor.uri-list', fileUri)
      const body = document.querySelector<HTMLElement>('[data-testid="editor-group-body"]')!
      const r = body.getBoundingClientRect()
      const opts = {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: r.left + r.width / 2,
        clientY: r.top + 20,
        dataTransfer: dt,
      }
      body.dispatchEvent(new DragEvent('dragenter', opts))
      body.dispatchEvent(new DragEvent('dragover', opts))
    }, uri)
    await expect.poll(() => overlayVisible(page), { timeout: 3000 }).toBe(true)

    // Phase 2: pointer moves down onto the prompt input. The dragover now
    // originates from the input host and bubbles to the body handler, which must
    // recognise it and drop the overlay — the input owns this drop.
    await page.evaluate((fileUri) => {
      const dt = new DataTransfer()
      dt.setData('text/uri-list', fileUri)
      dt.setData('application/vnd.universe-editor.uri-list', fileUri)
      const host = document.querySelector<HTMLElement>('[data-testid="acp-prompt-drop-host"]')!
      const r = host.getBoundingClientRect()
      const opts = {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: r.left + r.width / 2,
        clientY: r.top + r.height / 2,
        dataTransfer: dt,
      }
      host.dispatchEvent(new DragEvent('dragover', opts))
    }, uri)

    await expect.poll(() => overlayVisible(page), { timeout: 3000 }).toBe(false)

    await tryCleanup(tmpDir)
  })

  test('editor overlay clears after the drag is cancelled (dragend, no drop on body)', async ({
    page,
    workbench,
  }) => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ue2-sedo2-'))
    await fs.writeFile(path.join(tmpDir, 'a.txt'), 'x')
    await openSessionInEditor(page, workbench, tmpDir)

    const uri = `file:///${tmpDir.replace(/\\/g, '/')}/a.txt`

    // Phase 1: drag over the editor body (above the input) to light the overlay.
    await page.evaluate((fileUri) => {
      const dt = new DataTransfer()
      dt.setData('text/uri-list', fileUri)
      dt.setData('application/vnd.universe-editor.uri-list', fileUri)
      const body = document.querySelector<HTMLElement>('[data-testid="editor-group-body"]')!
      const r = body.getBoundingClientRect()
      const opts = {
        bubbles: true,
        cancelable: true,
        composed: true,
        // Near the top of the body — above the prompt input, over the chat area.
        clientX: r.left + r.width / 2,
        clientY: r.top + 20,
        dataTransfer: dt,
      }
      body.dispatchEvent(new DragEvent('dragenter', opts))
      body.dispatchEvent(new DragEvent('dragover', opts))
    }, uri)

    // Overlay is on (also lets React flush + the window safety-net register).
    await expect.poll(() => overlayVisible(page), { timeout: 3000 }).toBe(true)

    // Phase 2: user presses Esc / releases elsewhere — only a window `dragend`
    // fires; the body gets no drop/leave.
    await page.evaluate(() => {
      window.dispatchEvent(new DragEvent('dragend', { bubbles: false, cancelable: true }))
    })

    await expect.poll(() => overlayVisible(page), { timeout: 3000 }).toBe(false)

    await tryCleanup(tmpDir)
  })
})
