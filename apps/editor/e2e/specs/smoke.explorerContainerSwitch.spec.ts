/*---------------------------------------------------------------------------------------------
 *  Smoke spec: switching back to a large Explorer must not render every row (P1).
 *
 *  Regression guard for "Ctrl+Shift+E takes seconds in big workspaces". View
 *  container switches unmount the inactive container, so Explorer remounts on
 *  every switch back. Allotment sizes the pane on a later layout tick, and until
 *  then the `height:100%` tree root measures its *content* height. The
 *  virtualizer measured that number during its layout effect and rendered all
 *  ~1.2k rows synchronously, only to discard them once the pane was laid out —
 *  seconds of style/layout work on a real 17k-entry workspace.
 *
 *  The tree's first measurement is now gated on a trustworthy viewport (see
 *  packages/workbench-ui/cases-virtualization-scroll.md §7). This spec drives the
 *  real container switch and samples the DOM while it happens: the peak number
 *  of live rows must stay near one viewport, not near the model size.
 *
 *  Peak, not steady state: the pre-fix mount also settles back to ~35 rows after
 *  layout, so a post-hoc row count would pass either way.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/sharedApp.js'
import { mkTempDir } from '@universe-editor/e2e-harness'

const FILE_COUNT = 1200
// 1 root + 1200 files. Any plausible row height (>= 8px) puts the scroll range
// far above this, so the assertion proves the model is loaded without baking
// today's 22px row height into the threshold; a partially populated tree would
// make the peak assertion vacuous.
const MIN_CONTENT_HEIGHT = 10_000
// One viewport of rows plus overscan is ~40. 500 leaves room for a taller CI
// window and stray re-renders while still failing by an order of magnitude when
// the whole tree is rendered.
const MAX_PEAK_ROWS = 500

const SEARCH = 'workbench.view.search'
const EXPLORER = 'workbench.view.explorer'
// The Search container renders its own empty-state tree, so every query is
// scoped to the Explorer view body rather than "the first [role=tree]".

interface ProbeState {
  peak: number
  live: Set<Element>
  stop: () => void
}

type ProbeWindow = Window & { __treeRowProbe?: ProbeState }

async function readTree(page: Page): Promise<{ rows: number; scrollHeight: number } | null> {
  return page.evaluate(() => {
    const tree = document.querySelector<HTMLElement>(
      '[data-view-id="workbench.view.explorer.tree"] [role="tree"]',
    )
    if (!tree) return null
    return {
      rows: tree.querySelectorAll('[role="treeitem"]').length,
      scrollHeight: tree.scrollHeight,
    }
  })
}

async function seedWorkspace(): Promise<string> {
  const tmpDir = mkTempDir('ue2-container-switch-')
  // Batched so 1200 concurrent opens don't exhaust the file descriptor table.
  const BATCH = 100
  for (let start = 0; start < FILE_COUNT; start += BATCH) {
    const size = Math.min(BATCH, FILE_COUNT - start)
    await Promise.all(
      Array.from({ length: size }, (_, i) =>
        fs.writeFile(path.join(tmpDir, `file-${String(start + i).padStart(4, '0')}.txt`), 'x'),
      ),
    )
  }
  return tmpDir
}

/**
 * Installs a peak-row probe for the duration of the container switch.
 *
 * Mutation records are replayed in order against a live set, so a commit that
 * inserts the whole tree and a later commit that removes it still reports the
 * intermediate count. rAF sampling over the same interval is the backstop for
 * DOM churn that bypasses childList records. Only rows inside the Explorer view
 * body are counted, so other trees in the workbench cannot inflate the peak; the
 * probe is installed only after the old tree is gone so its teardown does not
 * count either.
 */
async function installRowProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = {
      peak: 0,
      live: new Set<Element>(),
      stop: () => {},
    }
    ;(window as unknown as ProbeWindow).__treeRowProbe = state

    const rowsIn = (node: Node): Element[] => {
      if (!(node instanceof Element)) return []
      const found: Element[] = node.matches('[role="treeitem"]') ? [node] : []
      found.push(...node.querySelectorAll('[role="treeitem"]'))
      return found.filter(
        (row) => row.closest('[data-view-id="workbench.view.explorer.tree"]') !== null,
      )
    }

    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          for (const row of rowsIn(node)) state.live.add(row)
        }
        for (const node of record.removedNodes) {
          for (const row of rowsIn(node)) state.live.delete(row)
        }
      }
      state.peak = Math.max(state.peak, state.live.size)
    })
    observer.observe(document.body, { childList: true, subtree: true })

    let running = true
    const sample = (): void => {
      if (!running) return
      state.peak = Math.max(
        state.peak,
        document.querySelectorAll('[data-view-id="workbench.view.explorer.tree"] [role="treeitem"]')
          .length,
      )
      requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)

    state.stop = (): void => {
      running = false
      observer.disconnect()
    }
  })
}

async function readPeak(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as ProbeWindow).__treeRowProbe?.peak ?? -1)
}

async function stopRowProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as ProbeWindow
    w.__treeRowProbe?.stop()
    delete w.__treeRowProbe
  })
}

test.describe('@p1 explorer container switch', () => {
  test('switching back to a large Explorer renders one viewport of rows, not the whole tree @regression', async ({
    workbench,
    page,
  }) => {
    const tmpDir = await seedWorkspace()
    await workbench.waitForRestored()
    await workbench.openWorkspace(tmpDir)

    // The model is loaded and virtualized (windowed) once the scroll range is
    // 1.2k rows tall. Below the threshold the tree renders everything, which
    // would make "peak rows" meaningless.
    await expect
      .poll(() => readTree(page).then((t) => t?.scrollHeight ?? 0), { timeout: 15000 })
      .toBeGreaterThan(MIN_CONTENT_HEIGHT)
    await expect
      .poll(() => readTree(page).then((t) => t?.rows ?? Number.POSITIVE_INFINITY), {
        timeout: 15000,
      })
      .toBeLessThan(MAX_PEAK_ROWS)

    // Switch away: the inactive view container is unmounted with its tree.
    await workbench.activityBar.click(SEARCH)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveViewContainerId(0)), {
        timeout: 5000,
      })
      .toBe(SEARCH)
    await expect.poll(() => readTree(page), { timeout: 5000 }).toBeNull()

    await installRowProbe(page)

    // Same code path as Ctrl+Shift+E: focusView switches the active container
    // and focuses the remounted tree.
    await workbench.runCommand(EXPLORER)

    await expect
      .poll(() => readTree(page).then((t) => t?.rows ?? 0), { timeout: 15000 })
      .toBeGreaterThan(0)

    // Once rows exist, the probe has seen every intermediate commit. Reading the
    // peak after the fact is deliberate: the pre-fix tree inserted all 1,201
    // rows and removed them again before the viewport settled.
    const peak = await readPeak(page)
    const tree = await readTree(page)
    await stopRowProbe(page)

    expect(peak).toBeGreaterThan(0)
    expect(peak).toBeLessThan(MAX_PEAK_ROWS)
    expect(tree?.rows ?? 0).toBeLessThan(MAX_PEAK_ROWS)
    // The gate must not collapse the scroll range: the full model is still there.
    expect(tree?.scrollHeight ?? 0).toBeGreaterThan(MIN_CONTENT_HEIGHT)

    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })
})
