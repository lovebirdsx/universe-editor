/*---------------------------------------------------------------------------------------------
 *  Regression: dropping a resource onto a specific editor group must open it in
 *  THAT group, not the active one. Two bugs this covers:
 *    1. Drop onto the right group while the left is active → file opened left.
 *    2. File already open in the active (left) group, drop onto the right group →
 *       no-op, because openEditor deduped "already open" against the active group.
 *  Both stem from the drop not activating its target group first.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import { test, expect } from '../fixtures/sharedApp.js'

async function tryCleanup(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  } catch {
    /* OS reaps tmp */
  }
}

// Drop `uri` onto the body of the editor group at DOM index `groupIndex`.
async function dropUriOntoGroup(
  page: import('@playwright/test').Page,
  groupIndex: number,
  uri: string,
): Promise<void> {
  await page.evaluate(
    ([idx, u]) => {
      const bodies = document.querySelectorAll<HTMLElement>('[data-testid="editor-group-body"]')
      const body = bodies[idx as number]!
      const dt = new DataTransfer()
      dt.setData('text/uri-list', u as string)
      dt.setData('application/vnd.universe-editor.uri-list', u as string)
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
    [groupIndex, uri] as const,
  )
}

// Drag the tab whose label contains `tabText` (found in the tab bar at DOM index
// `barIndex`) onto the right edge of its own group body, splitting it into a new
// group. Crucially we DO NOT fire `dragend`: in a real split the source tab is
// unmounted (moved to the new group) before the browser can dispatch `dragend`
// to it, so `useDragHandle`'s onDragEnd/clearPayload never runs — reproducing the
// stale-payload condition. The provider must clear the payload on the window-level
// `drop` instead.
async function dragTabToOwnRightEdge(
  page: import('@playwright/test').Page,
  barIndex: number,
  tabText: string,
): Promise<void> {
  await page.evaluate(
    ([bar, text]) => {
      const bars = document.querySelectorAll<HTMLElement>('[data-testid="editor-group-tabbar"]')
      const bodies = document.querySelectorAll<HTMLElement>('[data-testid="editor-group-body"]')
      const source = Array.from(
        bars[bar as number]?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [],
      ).find((t) => (t.textContent ?? '').includes(text as string))
      const body = bodies[bar as number]
      if (!source || !body) throw new Error('drag source / body missing')
      const dt = new DataTransfer()
      const fire = (el: HTMLElement, type: string, x: number, y: number): void => {
        el.dispatchEvent(
          new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            clientX: x,
            clientY: y,
            dataTransfer: dt,
          }),
        )
      }
      const r = body.getBoundingClientRect()
      const edgeX = r.left + r.width * 0.92
      const midY = r.top + r.height / 2
      fire(source, 'dragstart', r.left + r.width / 2, midY)
      fire(body, 'dragover', edgeX, midY)
      fire(body, 'drop', edgeX, midY)
      // Intentionally no `dragend` — see the function comment.
    },
    [barIndex, tabText] as const,
  )
}

test.describe('@p1 drop into a specific group', () => {
  test(
    'dropping onto the right group opens the file there, not in the active left group',
    { tag: '@serial' },
    async ({ page, workbench }) => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ue2-dropgrp-'))
      await fs.writeFile(path.join(tmpDir, 'left.ts'), 'const l = 1\n')
      await fs.writeFile(path.join(tmpDir, 'right.ts'), 'const r = 1\n')
      await fs.writeFile(path.join(tmpDir, 'target.ts'), 'const t = 2\n')
      const rootFs = tmpDir.replace(/\\/g, '/')

      await workbench.waitForRestored()
      await workbench.openWorkspace(tmpDir)

      // left.ts in the left group; split (right group active); replace the right
      // group's cloned left.ts with right.ts so the two groups are distinguishable,
      // then re-activate the left group. Drop target lands on the non-active right.
      await page.evaluate(
        (p) => window.__E2E__!.openFileUri(p, { pinned: true }),
        `${rootFs}/left.ts`,
      )
      await workbench.runCommand('workbench.action.splitEditorRight')
      await expect.poll(() => workbench.getEditorGroupCount(), { timeout: 5000 }).toBe(2)
      await page.evaluate(
        (p) => window.__E2E__!.openFileUri(p, { pinned: true }),
        `${rootFs}/right.ts`,
      )
      await page.evaluate(() => window.__E2E__!.runCommand('workbench.action.focusFirstGroup'))
      await expect.poll(() => workbench.getEditorGroupCount(), { timeout: 5000 }).toBe(2)

      const bodies = page.locator('[data-testid="editor-group-body"]')
      await expect(bodies).toHaveCount(2, { timeout: 5000 })

      // Drop target.ts onto the right (index 1) group.
      await dropUriOntoGroup(page, 1, `file:///${rootFs}/target.ts`)

      // target.ts must become the active editor (it opened in the right group and
      // that group activated), NOT silently open in the left group.
      await expect
        .poll(() => workbench.getActiveEditorUri(), { timeout: 5000 })
        .toContain('target.ts')
      // The active group must be the RIGHT one: it holds right.ts + target.ts.
      // Were the drop opened in the (previously active) left group instead, the
      // active group would be left.ts's group and would NOT contain right.ts.
      // (The right group also carries left.ts cloned by the split — expected.)
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getActiveGroupEditorUris()), {
          timeout: 5000,
        })
        .toEqual(
          expect.arrayContaining([
            expect.stringContaining('right.ts'),
            expect.stringContaining('target.ts'),
          ]),
        )

      await tryCleanup(tmpDir)
    },
  )

  test(
    'a file already open in the active group still opens when dropped on another group',
    { tag: '@serial' },
    async ({ page, workbench }) => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ue2-dropgrp2-'))
      await fs.writeFile(path.join(tmpDir, 'shared.ts'), 'const s = 1\n')
      await fs.writeFile(path.join(tmpDir, 'other.ts'), 'const o = 1\n')
      const rootFs = tmpDir.replace(/\\/g, '/')

      await workbench.waitForRestored()
      await workbench.openWorkspace(tmpDir)

      // shared.ts open in the left group; split (right group now active).
      await page.evaluate(
        (p) => window.__E2E__!.openFileUri(p, { pinned: true }),
        `${rootFs}/shared.ts`,
      )
      await workbench.runCommand('workbench.action.splitEditorRight')
      await expect.poll(() => workbench.getEditorGroupCount(), { timeout: 5000 }).toBe(2)
      // Replace the right group's cloned shared.ts with other.ts so the right group
      // is non-empty but does NOT already contain shared.ts; then re-activate left.
      await page.evaluate(
        (p) => window.__E2E__!.openFileUri(p, { pinned: true }),
        `${rootFs}/other.ts`,
      )
      await page.evaluate(() => window.__E2E__!.runCommand('workbench.action.focusFirstGroup'))
      await expect.poll(() => workbench.getEditorGroupCount(), { timeout: 5000 }).toBe(2)

      const bodies = page.locator('[data-testid="editor-group-body"]')
      await expect(bodies).toHaveCount(2, { timeout: 5000 })

      // Drop shared.ts (already open in the active left group) onto the right group.
      await dropUriOntoGroup(page, 1, `file:///${rootFs}/shared.ts`)

      // It must open in the right group (now active) alongside other.ts, not no-op.
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getActiveGroupEditorUris()), {
          timeout: 5000,
        })
        .toEqual(
          expect.arrayContaining([
            expect.stringContaining('other.ts'),
            expect.stringContaining('shared.ts'),
          ]),
        )

      await tryCleanup(tmpDir)
    },
  )

  // Repro of the reported bug: open a, open b, drag b's tab to the right to split
  // into two groups, then drag c (a file) onto a tab/body. The split unmounts b's
  // source tab before the browser can dispatch `dragend`, so the in-tree payload
  // ({editor,sourceGroupId}) lingers in the DragSessionProvider. The subsequent
  // file drop then reads that stale payload, takes the "tab move" branch instead
  // of openDroppedResource — the open silently no-ops (nothing in the output).
  test(
    'a file dropped after a tab-split still opens (stale drag payload cleared)',
    { tag: '@serial' },
    async ({ page, workbench }) => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ue2-dropgrp3-'))
      await fs.writeFile(path.join(tmpDir, 'a.ts'), 'const a = 1\n')
      await fs.writeFile(path.join(tmpDir, 'b.ts'), 'const b = 1\n')
      await fs.writeFile(path.join(tmpDir, 'c.ts'), 'const c = 1\n')
      const rootFs = tmpDir.replace(/\\/g, '/')

      await workbench.waitForRestored()
      await workbench.openWorkspace(tmpDir)

      // Open a then b in the single (left) group.
      await page.evaluate((p) => window.__E2E__!.openFileUri(p, { pinned: true }), `${rootFs}/a.ts`)
      await page.evaluate((p) => window.__E2E__!.openFileUri(p, { pinned: true }), `${rootFs}/b.ts`)
      await expect.poll(() => workbench.getEditorGroupCount(), { timeout: 5000 }).toBe(1)

      const bodies = page.locator('[data-testid="editor-group-body"]')
      await expect(bodies).toHaveCount(1, { timeout: 5000 })
      // Body needs a real layout box before the edge-split drop.
      await expect
        .poll(
          async () => {
            const box = await bodies.nth(0).boundingBox()
            return box ? Math.min(box.width, box.height) : 0
          },
          { timeout: 5000 },
        )
        .toBeGreaterThan(0)

      // Drag b's tab to the right edge → splits into a second group. No `dragend`
      // fires on the (now unmounted) source tab, so the payload would linger.
      await dragTabToOwnRightEdge(page, 0, 'b.ts')
      await expect.poll(() => workbench.getEditorGroupCount(), { timeout: 5000 }).toBe(2)
      await expect(bodies).toHaveCount(2, { timeout: 5000 })

      // Now drop c.ts onto the (left, index 0) group. Before the fix this hit the
      // stale-payload "tab move" branch and no-op'd; c.ts would never open.
      await dropUriOntoGroup(page, 0, `file:///${rootFs}/c.ts`)

      await expect.poll(() => workbench.getActiveEditorUri(), { timeout: 5000 }).toContain('c.ts')

      await tryCleanup(tmpDir)
    },
  )
})
