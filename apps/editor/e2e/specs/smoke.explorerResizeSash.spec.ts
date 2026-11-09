/*---------------------------------------------------------------------------------------------
 *  Explorer 侧栏 resize seam vs. 可拖拽行：手势归属回归（@regression）。
 *
 *  Bug: 按压落在侧栏右缝内侧几像素时，命中的是 Explorer 行（含 hover 预览按钮），
 *  行的 draggable 抢走指针，启动原生文件拖拽而不是 resize。旧的 resizeEdgeGuard
 *  只在 dragstart 取消（且只有 X 轴 6px 带），既交接不了手势，也覆盖不到 seam-7。
 *
 *  两个用例：
 *   A. 在 seam-7（预览按钮上）按下并水平拖动 60px → 侧栏变宽、没有 dragstart、
 *      不打开文件/预览。
 *   B. 同一位置单击不移动 → 预览按钮照常打开预览（延迟转发不得吞掉点击）。
 *
 *  溢出场景（Explorer 出现 8px 滚动条，预览按钮被推到 seam 带外）另起一组：
 *   C. 从预览按钮中心拖动 → 绝不启动文件拖拽（dragstart 被取消），也不 resize。
 *   D. 直接按在 sash 中心拖动 → 照常 resize。
 *
 *  另有用例：拖动中途 window blur 必须结束 Allotment 的 window 监听，
 *  否则后续每次 mousemove 都会继续缩放。
 *--------------------------------------------------------------------------------------------*/

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/electronApp.js'

const ALPHA_ROW = '[data-row-key$="alpha.md"]'
const PREVIEW_BUTTON = `${ALPHA_ROW} [data-testid="explorer-open-preview"]`
const SIDEBAR_SASH = '[data-testid="sash"].sash-vertical'
const OVERFLOW_ROW = '[data-row-key$="file-00.md"]'
const OVERFLOW_PREVIEW_BUTTON = `${OVERFLOW_ROW} [data-testid="explorer-open-preview"]`

const OVERFLOW_FILES = Array.from({ length: 80 }, (_, i) => `file-${String(i).padStart(2, '0')}.md`)

test.use({
  workspaceSeeder: {
    seed(dir) {
      writeFileSync(join(dir, 'alpha.md'), '# alpha\n')
      writeFileSync(join(dir, 'beta.md'), '# beta\n')
    },
  },
})

interface SeamGeometry {
  readonly seamX: number
  readonly rowY: number
}

async function seamGeometry(page: Page): Promise<SeamGeometry> {
  const sash = page.locator(SIDEBAR_SASH).first()
  const row = page.locator(ALPHA_ROW)
  await expect
    .poll(async () => (await sash.boundingBox())?.width ?? 0, { timeout: 10_000 })
    .toBeGreaterThan(0)
  await expect(row).toBeVisible({ timeout: 10_000 })
  const sashBox = await sash.boundingBox()
  const rowBox = await row.boundingBox()
  if (!sashBox || !rowBox) throw new Error('sash or alpha.md row not laid out yet')
  return {
    seamX: sashBox.x + sashBox.width / 2,
    rowY: rowBox.y + rowBox.height / 2,
  }
}

async function layoutSidebar(page: Page): Promise<number> {
  return page.evaluate(() => window.__E2E__!.getLayoutSizes().sidebar)
}

// Layout sizes are persisted on drag end, so mid-gesture assertions need the
// live sash position instead.
async function sashLeft(page: Page): Promise<number> {
  return page.evaluate(() => {
    const sash = document.querySelector('[data-testid="sash"].sash-vertical')
    if (!sash) throw new Error('vertical sash missing')
    return sash.getBoundingClientRect().left
  })
}

test.describe('explorer resize seam', () => {
  test('dragging from the row preview button resizes the sidebar instead of starting a file drag @regression', async ({
    page,
    workbench,
  }) => {
    test.setTimeout(120_000)
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()

    const { seamX, rowY } = await seamGeometry(page)
    const pressX = seamX - 7

    // Hover the seam-side pixel: the row's floating preview button appears there.
    await page.mouse.move(pressX, rowY)
    await expect(page.locator(PREVIEW_BUTTON)).toBeVisible({ timeout: 5_000 })
    const onPreviewButton = await page.evaluate(
      ({ x, y }) =>
        document.elementFromPoint(x, y)?.closest('[data-testid="explorer-open-preview"]') !== null,
      { x: pressX, y: rowY },
    )
    expect(
      onPreviewButton,
      'the repro must press on the row action button, not bare row space',
    ).toBe(true)

    const before = await layoutSidebar(page)
    const beforeEditor = await workbench.getActiveEditorUri()

    await page.evaluate(() => {
      const w = window as unknown as { __dragStarts?: number }
      w.__dragStarts = 0
      document.addEventListener(
        'dragstart',
        (e) => {
          w.__dragStarts = (w.__dragStarts ?? 0) + 1
          e.preventDefault()
        },
        true,
      )
    })

    await page.mouse.down()
    await page.mouse.move(pressX + 60, rowY, { steps: 10 })
    await page.mouse.up()

    await expect
      .poll(() => layoutSidebar(page), { timeout: 5_000 })
      .toBeGreaterThanOrEqual(before + 55)
    await expect
      .poll(() => layoutSidebar(page), { timeout: 5_000 })
      .toBeLessThanOrEqual(before + 65)

    expect(
      await page.evaluate(() => (window as unknown as { __dragStarts?: number }).__dragStarts),
    ).toBe(0)
    expect(await workbench.getActiveEditorUri()).toBe(beforeEditor)
    expect(await page.evaluate(() => window.__E2E__!.getActiveEditorTypeId())).not.toBe(
      'markdown.preview',
    )
  })

  test('clicking the same preview button still opens the preview @regression', async ({
    page,
    workbench,
  }) => {
    test.setTimeout(120_000)
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()

    const { seamX, rowY } = await seamGeometry(page)
    const pressX = seamX - 7
    await page.mouse.move(pressX, rowY)
    await expect(page.locator(PREVIEW_BUTTON)).toBeVisible({ timeout: 5_000 })

    const before = await layoutSidebar(page)
    await page.mouse.click(pressX, rowY)

    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), { timeout: 5_000 })
      .toBe('markdown.preview')
    const after = await layoutSidebar(page)
    expect(Math.abs(after - before)).toBeLessThanOrEqual(1)
  })

  test('window blur ends an in-flight sash drag @regression', async ({ page, workbench }) => {
    test.setTimeout(120_000)
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()

    const { seamX, rowY } = await seamGeometry(page)
    const before = await layoutSidebar(page)
    const startLeft = await sashLeft(page)

    await page.mouse.move(seamX, rowY)
    await page.mouse.down()
    await page.mouse.move(seamX + 30, rowY, { steps: 5 })

    await expect
      .poll(() => sashLeft(page), { timeout: 5_000 })
      .toBeGreaterThanOrEqual(startLeft + 25)

    // Allotment only removes its window pointer listeners from pointerup; a
    // blur would otherwise leave the sash resizing on every later mouse move.
    await page.evaluate(() => window.dispatchEvent(new Event('blur')))

    await expect
      .poll(() => layoutSidebar(page), { timeout: 5_000 })
      .toBeGreaterThanOrEqual(before + 25)
    const afterBlurLeft = await sashLeft(page)
    const afterBlurSize = await layoutSidebar(page)

    await page.mouse.move(seamX + 120, rowY, { steps: 5 })
    await page.waitForTimeout(100)
    expect(await sashLeft(page)).toBe(afterBlurLeft)
    expect(await layoutSidebar(page)).toBe(afterBlurSize)

    await page.mouse.up()
    expect(await sashLeft(page)).toBe(afterBlurLeft)
    expect(await layoutSidebar(page)).toBe(afterBlurSize)
  })
})

test.describe('overflowing explorer', () => {
  test.use({
    workspaceSeeder: {
      seed(dir) {
        for (const name of OVERFLOW_FILES) writeFileSync(join(dir, name), `# ${name}\n`)
      },
    },
  })

  test('dragging a row action button never starts a file drag @regression', async ({
    page,
    workbench,
  }) => {
    test.setTimeout(120_000)
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()

    const sash = page.locator(SIDEBAR_SASH).first()
    await expect
      .poll(async () => (await sash.boundingBox())?.width ?? 0, { timeout: 10_000 })
      .toBeGreaterThan(0)
    const sashBox = await sash.boundingBox()
    if (!sashBox) throw new Error('side bar sash not laid out yet')
    const seamX = sashBox.x + sashBox.width / 2

    const row = page.locator(OVERFLOW_ROW)
    await expect(row).toBeVisible({ timeout: 10_000 })
    const rowBox = await row.boundingBox()
    if (!rowBox) throw new Error('overflow row not laid out yet')
    await page.mouse.move(rowBox.x + rowBox.width / 2, rowBox.y + rowBox.height / 2)
    const button = page.locator(OVERFLOW_PREVIEW_BUTTON)
    await expect(button).toBeVisible({ timeout: 5_000 })
    const buttonBox = await button.boundingBox()
    if (!buttonBox) throw new Error('preview button not laid out yet')
    const buttonX = buttonBox.x + buttonBox.width / 2
    const buttonY = buttonBox.y + buttonBox.height / 2

    // The tree must actually overflow: the classic 8px scrollbar pushes the
    // preview button outside the guard's seam band, so the nested-control rule
    // — not seam arbitration — is what has to protect the gesture here.
    const overflow = await page.evaluate((rowSelector) => {
      let el = document.querySelector(rowSelector)?.parentElement
      while (el) {
        const style = getComputedStyle(el)
        if (
          (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
          el.scrollHeight > el.clientHeight
        ) {
          return true
        }
        el = el.parentElement
      }
      return false
    }, OVERFLOW_ROW)
    expect(overflow, 'the seeded tree must overflow to cover the scrollbar geometry').toBe(true)
    expect(
      Math.abs(buttonX - seamX),
      'button centre must sit outside the seam band',
    ).toBeGreaterThan(10)

    const onButton = await page.evaluate(
      ({ x, y }) =>
        document.elementFromPoint(x, y)?.closest('[data-testid="explorer-open-preview"]') !== null,
      { x: buttonX, y: buttonY },
    )
    expect(onButton).toBe(true)

    const before = await layoutSidebar(page)
    const beforeEditor = await workbench.getActiveEditorUri()
    await page.evaluate(() => {
      const w = window as unknown as { __dragStarts?: number; __dragPrevented?: number }
      w.__dragStarts = 0
      w.__dragPrevented = 0
      document.addEventListener(
        'dragstart',
        (e) => {
          w.__dragStarts = (w.__dragStarts ?? 0) + 1
          if (e.defaultPrevented) w.__dragPrevented = (w.__dragPrevented ?? 0) + 1
          e.preventDefault()
        },
        true,
      )
    })

    await page.mouse.move(buttonX, buttonY)
    await page.mouse.down()
    await page.mouse.move(buttonX + 60, buttonY, { steps: 10 })
    await page.mouse.up()

    const drag = await page.evaluate(() => {
      const w = window as unknown as { __dragStarts?: number; __dragPrevented?: number }
      return { starts: w.__dragStarts ?? 0, prevented: w.__dragPrevented ?? 0 }
    })
    expect(drag.starts, 'a native row drag must be observed').toBe(1)
    expect(drag.prevented, 'the nested-control guard must cancel it').toBe(1)
    expect(await workbench.getActiveEditorUri()).toBe(beforeEditor)
    expect(await layoutSidebar(page)).toBe(before)
  })

  test('dragging the sash itself still resizes with an overflowing explorer @regression', async ({
    page,
    workbench,
  }) => {
    test.setTimeout(120_000)
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()

    const sash = page.locator(SIDEBAR_SASH).first()
    await expect
      .poll(async () => (await sash.boundingBox())?.width ?? 0, { timeout: 10_000 })
      .toBeGreaterThan(0)
    const row = page.locator(OVERFLOW_ROW)
    await expect(row).toBeVisible({ timeout: 10_000 })
    const sashBox = await sash.boundingBox()
    const rowBox = await row.boundingBox()
    if (!sashBox || !rowBox) throw new Error('sash or overflow row not laid out yet')

    const seamX = sashBox.x + sashBox.width / 2
    const rowY = rowBox.y + rowBox.height / 2
    const before = await layoutSidebar(page)

    await page.mouse.move(seamX, rowY)
    await page.mouse.down()
    await page.mouse.move(seamX + 60, rowY, { steps: 10 })
    await page.mouse.up()

    await expect
      .poll(() => layoutSidebar(page), { timeout: 5_000 })
      .toBeGreaterThanOrEqual(before + 55)
    await expect
      .poll(() => layoutSidebar(page), { timeout: 5_000 })
      .toBeLessThanOrEqual(before + 65)
  })
})
