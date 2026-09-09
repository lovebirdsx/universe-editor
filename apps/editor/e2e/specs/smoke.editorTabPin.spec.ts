/*---------------------------------------------------------------------------------------------
 *  Editor tab pin (sticky) smoke tests.
 *
 *  Covers the VSCode sticky-tab contract:
 *   @p0
 *   1. pinEditor command sticks the active tab to the group front and flips the
 *      activeEditorIsPinned context key
 *   2. Ctrl+K Shift+Enter chord pins, then unpins (dual keybinding when)
 *   3. Ctrl+W skips a sticky tab and activates the next non-sticky editor
 *      (preventPinnedEditorClose: keyboardAndMouse)
 *   4. Close All keeps sticky tabs
 *   5. unpinEditor lands the tab right after the sticky region
 *   @p1
 *   6. Move-to-next-group carries the sticky flag across groups
 *   7. Sticky state survives a window reload (persisted cursor)
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test as coldTest, expect } from '../fixtures/electronApp.js'
import { test as sharedTest } from '../fixtures/sharedApp.js'
import type { Page } from '@playwright/test'

type EditorFlags = readonly { uri: string | undefined; sticky: boolean; preview: boolean }[]

async function openFile(page: Page, fsPath: string): Promise<void> {
  await page.evaluate((p) => window.__E2E__!.openFileUri(p), fsPath)
}

async function getFlags(page: Page): Promise<EditorFlags> {
  return page.evaluate(() => window.__E2E__!.getActiveGroupEditorFlags())
}

/** Basename-keyed flags so assertions stay platform-agnostic about the dir. */
function stickyOf(flags: EditorFlags, name: string): boolean {
  const flag = flags.find((f) => f.uri?.endsWith(`/${name}`))
  if (!flag) throw new Error(`editor ${name} not found in ${JSON.stringify(flags)}`)
  return flag.sticky
}

function namesOf(flags: EditorFlags): string[] {
  return flags.map((f) => f.uri?.split('/').pop() ?? '?')
}

/** A scratch folder whose cleanup rides out open handles on the running app. */
async function withTempFiles<T>(
  names: readonly string[],
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'universe-editor-tabpin-'))
  for (const name of names) writeFileSync(join(dir, name), name)
  try {
    return await fn(dir.replace(/\\/g, '/'))
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    } catch {
      /* best-effort */
    }
  }
}

const FOUR = ['a.txt', 'b.txt', 'c.txt', 'd.txt'] as const

sharedTest.describe('@p0 editor tab pin (sticky)', () => {
  sharedTest(
    'pin command sticks the active tab to the front and flips the context key',
    async ({ page, workbench }) => {
      await workbench.waitForRestored()
      await withTempFiles(FOUR, async (dir) => {
        await openFile(page, `${dir}/a.txt`)
        await openFile(page, `${dir}/b.txt`)
        await expect.poll(() => workbench.getActiveEditorUri()).toContain('b.txt')

        await expect
          .poll(() => workbench.getContextKey<boolean>('activeEditorIsPinned'))
          .toBe(false)

        await workbench.runCommand('workbench.action.pinEditor')
        await expect.poll(() => workbench.getContextKey<boolean>('activeEditorIsPinned')).toBe(true)

        await expect.poll(async () => namesOf(await getFlags(page))).toEqual(['b.txt', 'a.txt'])
        const flags = await getFlags(page)
        expect(stickyOf(flags, 'b.txt')).toBe(true)
        expect(stickyOf(flags, 'a.txt')).toBe(false)
      })
    },
  )

  sharedTest('Ctrl+K Shift+Enter pins then unpins the active tab', async ({ page, workbench }) => {
    await workbench.waitForRestored()
    await withTempFiles(FOUR, async (dir) => {
      await openFile(page, `${dir}/a.txt`)
      await expect.poll(() => workbench.getActiveEditorUri()).toContain('a.txt')

      // The chord is when-gated on activeEditorIsPinned, and keybinding chords
      // resolve against the root context — which is only authoritative while
      // no Monaco widget holds focus (same focus gating the Ctrl+K group
      // navigation chords rely on). Ensure the editor part owns focus.
      await workbench.focusActiveEditorGroup()
      await page.keyboard.press('Control+k')
      await page.keyboard.press('Shift+Enter')
      await expect.poll(() => workbench.getContextKey<boolean>('activeEditorIsPinned')).toBe(true)

      await workbench.focusActiveEditorGroup()
      await page.keyboard.press('Control+k')
      await page.keyboard.press('Shift+Enter')
      await expect.poll(() => workbench.getContextKey<boolean>('activeEditorIsPinned')).toBe(false)
      expect(stickyOf(await getFlags(page), 'a.txt')).toBe(false)
    })
  })

  sharedTest(
    'Ctrl+W skips the sticky tab and activates the next non-sticky editor',
    async ({ page, workbench }) => {
      await workbench.waitForRestored()
      await withTempFiles(FOUR, async (dir) => {
        await openFile(page, `${dir}/a.txt`)
        await openFile(page, `${dir}/b.txt`)
        await openFile(page, `${dir}/c.txt`)
        await workbench.runCommand('workbench.action.pinEditor')
        await expect
          .poll(async () => namesOf(await getFlags(page)))
          .toEqual(['c.txt', 'a.txt', 'b.txt'])

        // Ctrl+W on the sticky active tab: no close, activation moves to the MRU
        // non-sticky editor (b.txt — it was active before c.txt was opened).
        await workbench.focusActiveEditorGroup()
        await page.keyboard.press('Control+w')
        await expect.poll(() => workbench.getActiveEditorUri()).toContain('b.txt')
        await expect.poll(async () => (await getFlags(page)).length).toBe(3)

        // Ctrl+W again now closes the non-sticky active editor for real.
        await page.keyboard.press('Control+w')
        await expect.poll(async () => namesOf(await getFlags(page))).toEqual(['c.txt', 'a.txt'])
        expect(stickyOf(await getFlags(page), 'c.txt')).toBe(true)
      })
    },
  )

  sharedTest('Close All keeps sticky tabs', async ({ page, workbench }) => {
    await workbench.waitForRestored()
    await withTempFiles(FOUR, async (dir) => {
      await openFile(page, `${dir}/a.txt`)
      await openFile(page, `${dir}/b.txt`)
      await openFile(page, `${dir}/c.txt`)
      await workbench.runCommand('workbench.action.pinEditor')
      await expect.poll(() => workbench.getContextKey<boolean>('activeEditorIsPinned')).toBe(true)

      await workbench.runCommand('workbench.action.closeAllEditors')
      await expect.poll(async () => namesOf(await getFlags(page))).toEqual(['c.txt'])
      expect(stickyOf(await getFlags(page), 'c.txt')).toBe(true)
    })
  })

  sharedTest('unpin lands the tab right after the sticky region', async ({ page, workbench }) => {
    await workbench.waitForRestored()
    await withTempFiles(FOUR, async (dir) => {
      // Sticking moves the tab to the end of the sticky region, so pinning
      // c then b yields the region [c, b] with plain tabs behind.
      await openFile(page, `${dir}/a.txt`)
      await openFile(page, `${dir}/b.txt`)
      await openFile(page, `${dir}/c.txt`)
      await workbench.runCommand('workbench.action.pinEditor')
      await openFile(page, `${dir}/b.txt`)
      await workbench.runCommand('workbench.action.pinEditor')
      await expect
        .poll(async () => namesOf(await getFlags(page)))
        .toEqual(['c.txt', 'b.txt', 'a.txt'])

      // Unpin b (the sticky region tail): it lands at the first non-sticky
      // slot, ahead of plain tabs.
      await workbench.runCommand('workbench.action.unpinEditor')
      await expect
        .poll(async () => namesOf(await getFlags(page)))
        .toEqual(['c.txt', 'b.txt', 'a.txt'])
      const flags = await getFlags(page)
      expect(stickyOf(flags, 'c.txt')).toBe(true)
      expect(stickyOf(flags, 'b.txt')).toBe(false)
    })
  })
})

coldTest.describe('@p1 editor tab pin (sticky) — cross-group and restore', () => {
  coldTest.use({
    workspaceSeeder: {
      seed(dir) {
        for (const name of FOUR) writeFileSync(join(dir, name), name)
      },
    },
  })

  coldTest(
    'moving a sticky editor to another group keeps it sticky',
    async ({ page, workbench, launchWorkspace }) => {
      await workbench.waitForRestored()
      if (!launchWorkspace) throw new Error('workspace seeder did not run')

      await openFile(page, launchWorkspace.file('a.txt'))
      await openFile(page, launchWorkspace.file('b.txt'))
      await workbench.runCommand('workbench.action.pinEditor')

      await workbench.runCommand('workbench.action.splitEditorRight')
      await expect.poll(() => workbench.getEditorGroupCount()).toBe(2)
      // splitEditorRight copies the active editor into the new group; open c.txt
      // there so the right group has its own non-sticky tab.
      await openFile(page, launchWorkspace.file('c.txt'))
      await expect.poll(() => workbench.getActiveEditorUri()).toContain('c.txt')

      // Focus back to the left group (its active editor is the sticky b.txt
      // left behind), then move it into the next (right) group.
      await workbench.runCommand('workbench.action.focusPreviousGroup')
      await expect.poll(() => workbench.getActiveEditorUri()).toContain('b.txt')
      await expect.poll(() => workbench.getContextKey<boolean>('activeEditorIsPinned')).toBe(true)

      await workbench.runCommand('workbench.action.moveEditorToNextGroup')
      await expect.poll(async () => namesOf(await getFlags(page))).toEqual(['b.txt', 'c.txt'])
      const flags = await getFlags(page)
      expect(stickyOf(flags, 'b.txt')).toBe(true)
      expect(stickyOf(flags, 'c.txt')).toBe(false)
    },
  )

  coldTest(
    'sticky state survives a window reload',
    async ({ page, workbench, launchWorkspace }) => {
      await workbench.waitForRestored()
      if (!launchWorkspace) throw new Error('workspace seeder did not run')

      await openFile(page, launchWorkspace.file('a.txt'))
      await openFile(page, launchWorkspace.file('b.txt'))
      await openFile(page, launchWorkspace.file('c.txt'))
      await workbench.runCommand('workbench.action.pinEditor')
      await expect
        .poll(async () => namesOf(await getFlags(page)))
        .toEqual(['c.txt', 'a.txt', 'b.txt'])

      // Workspace persistence is debounced (PERSIST_DEBOUNCE_MS = 200); give it
      // a comfortable margin before reloading.
      await page.waitForTimeout(500)
      await workbench.waitForRestartRestore()

      await expect
        .poll(async () => namesOf(await getFlags(page)))
        .toEqual(['c.txt', 'a.txt', 'b.txt'])
      const flags = await getFlags(page)
      expect(stickyOf(flags, 'c.txt')).toBe(true)
      expect(stickyOf(flags, 'a.txt')).toBe(false)
    },
  )
})
