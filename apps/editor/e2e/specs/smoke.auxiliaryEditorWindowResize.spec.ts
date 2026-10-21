/*---------------------------------------------------------------------------------------------
 *  Auxiliary editor window resize regression (@regression).
 *
 *  守护的 bug：编辑器移到辅助窗口后最大化，Monaco 只渲染最大化前的矩形，扩展区域空白。
 *  辅助窗口与主窗口共享 renderer 但各有独立 Document；Monaco 的 ElementSizeObserver 用
 *  主 realm 的裸 ResizeObserver 观察辅助 document 的容器。Blink 只在构造 observer 的
 *  window 的渲染生命周期里 gather/deliver 回调（LocalFrameView::NotifyResizeObservers
 *  取的是本 frame DomWindow 的 controller），所以主窗口停止渲染后，辅助窗口自身的布局
 *  变化再也送不到主 realm 的 observer，Monaco 的内联 px 尺寸停在最大化前。
 *
 *  复现条件：主窗口必须停止渲染。生产里由辅助窗口最大化后的遮挡触发；e2e 的 xvfb 下
 *  hide() 不会让 WebContents 进入 hidden（实测 visibilityState 恒为 VISIBLE），CDP
 *  Page.setWebLifecycleState 同样无效。改用 CDP 虚拟时间暂停主页面调度：rAF 计数守卫
 *  确认主 frame 真的停帧，否则用例会假绿。尺寸变化用 setBounds 确定性触发（xvfb 下
 *  maximize() 是 no-op）。辅助窗口不在该暂停范围内，仍会正常布局。
 *--------------------------------------------------------------------------------------------*/

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CDPSession, ElectronApplication, Page } from '@playwright/test'
import { test, expect } from '../fixtures/electronApp.js'

/** 观察窗口是否还在产生帧；400ms 是「确认不前进」的观察窗，不是等待条件。 */
const FRAME_GUARD_MS = 400

type RafProbeWindow = Window & { __ueRafTicks?: number; __ueRafStop?: boolean }

function getWindowId(electronApp: ElectronApplication, auxiliary: boolean): Promise<number> {
  return electronApp.evaluate(({ BrowserWindow }, aux) => {
    const win = BrowserWindow.getAllWindows().find(
      (candidate) => (candidate.webContents.getURL() === 'about:blank') === aux,
    )
    if (!win) throw new Error(aux ? 'auxiliary window not found' : 'main window not found')
    return win.id
  }, auxiliary)
}

async function getBounds(
  electronApp: ElectronApplication,
  windowId: number,
): Promise<{ width: number; height: number }> {
  return electronApp.evaluate(({ BrowserWindow }, id) => {
    const win = BrowserWindow.fromId(id)
    if (!win) throw new Error(`BrowserWindow ${id} is gone`)
    const { width, height } = win.getBounds()
    return { width, height }
  }, windowId)
}

async function setSize(
  electronApp: ElectronApplication,
  windowId: number,
  size: { width: number; height: number },
): Promise<void> {
  await electronApp.evaluate(
    ({ BrowserWindow }, { id, width, height }) => {
      const win = BrowserWindow.fromId(id)
      if (!win) throw new Error(`BrowserWindow ${id} is gone`)
      const bounds = win.getBounds()
      win.setBounds({ x: bounds.x, y: bounds.y, width, height })
    },
    { id: windowId, ...size },
  )
}

function layoutInfo(page: Page, groupId: string) {
  return page.evaluate((gid) => window.__E2E__!.getEditorLayoutInfo(gid), groupId)
}

/** Monaco 画布必须铺满它自己的容器；返回偏差便于 poll。 */
function layoutMismatch(page: Page, groupId: string): Promise<number> {
  return page.evaluate((gid) => {
    const info = window.__E2E__!.getEditorLayoutInfo(gid)
    if (!info) return Number.POSITIVE_INFINITY
    return Math.max(
      Math.abs(info.layout.width - info.container.width),
      Math.abs(info.layout.height - info.container.height),
    )
  }, groupId)
}

test.describe('@p1 auxiliary editor window resize', () => {
  test('moved editor keeps its Monaco layout in sync after a native resize @regression', async ({
    electronApp,
    workbench,
    page,
    scratchDir,
  }) => {
    test.setTimeout(120_000)
    test.slow()

    await workbench.waitForRestored()
    const file = join(scratchDir('ue-aux-resize-'), 'resize-me.txt')
    writeFileSync(file, Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join('\n'))
    await page.evaluate((p) => window.__E2E__!.openFileUri(p), file.replace(/\\/g, '/'))
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorUri()))
      .toContain('resize-me.txt')

    const mainWindowId = await getWindowId(electronApp, false)
    const mainGroupId = String(
      (await page.evaluate(() => window.__E2E__!.getWorkbenchWindows()))[0]!.groupIds[0]!,
    )
    await expect.poll(() => layoutInfo(page, mainGroupId)).toBeDefined()

    // Control: the main window's editor still follows a native resize (the patch
    // must keep the same-realm path intact).
    const mainBounds = await getBounds(electronApp, mainWindowId)
    await setSize(electronApp, mainWindowId, {
      width: mainBounds.width - 80,
      height: mainBounds.height,
    })
    await expect
      .poll(async () => (await layoutInfo(page, mainGroupId))?.container.width ?? 0)
      .toBeLessThan(mainBounds.width - 40)
    await expect.poll(() => layoutMismatch(page, mainGroupId)).toBeLessThanOrEqual(1)
    await setSize(electronApp, mainWindowId, mainBounds)

    const windowPromise = electronApp.waitForEvent('window')
    await workbench.runCommand('workbench.action.moveEditorToNewWindow')
    const child = await windowPromise
    await child.waitForLoadState('domcontentloaded')
    await expect(child.locator('[data-testid="part-editorArea"]')).toBeVisible()

    await expect
      .poll(async () => {
        const [entry] = await page.evaluate(() => window.__E2E__!.getAuxiliaryWindows())
        return (
          entry?.groups.some((group) =>
            group.editorUris.some((uri) => uri.includes('resize-me.txt')),
          ) ?? false
        )
      })
      .toBe(true)
    const auxSnapshot = (await page.evaluate(() => window.__E2E__!.getAuxiliaryWindows()))[0]!
    const auxGroupId = String(
      auxSnapshot.groups.find((group) =>
        group.editorUris.some((uri) => uri.includes('resize-me.txt')),
      )!.id,
    )
    await expect.poll(async () => (await layoutInfo(page, auxGroupId))?.auxiliary).toBe(true)
    const initial = (await layoutInfo(page, auxGroupId))!

    const auxWindowId = await getWindowId(electronApp, true)
    const auxBounds = await getBounds(electronApp, auxWindowId)

    let cdp: CDPSession | undefined
    try {
      // Stop the main frame's rendering. If rAF kept advancing in the paused
      // page, the test would go green before the fix, so the guard below fails
      // hard rather than letting the reproduction degrade silently.
      await page.evaluate(() => {
        const probe = window as RafProbeWindow
        probe.__ueRafTicks = 0
        probe.__ueRafStop = false
        const tick = () => {
          if (probe.__ueRafStop) return
          probe.__ueRafTicks = (probe.__ueRafTicks ?? 0) + 1
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
      await expect
        .poll(() => page.evaluate(() => (window as RafProbeWindow).__ueRafTicks ?? 0))
        .toBeGreaterThan(0)

      cdp = await page.context().newCDPSession(page)
      await cdp.send('Emulation.setVirtualTimePolicy', { policy: 'pause' })
      await page.waitForTimeout(FRAME_GUARD_MS)
      const ticks = await page.evaluate(() => (window as RafProbeWindow).__ueRafTicks ?? 0)
      await page.waitForTimeout(FRAME_GUARD_MS)
      expect(
        await page.evaluate(() => (window as RafProbeWindow).__ueRafTicks ?? 0),
        'main window kept rendering after virtual-time pause; the reproduction would be a false green',
      ).toBe(ticks)

      // Shrink first: the auxiliary document's own (child-realm) layout must
      // still react, proving the window itself is live while main is paused.
      await setSize(electronApp, auxWindowId, {
        width: auxBounds.width - 140,
        height: auxBounds.height - 120,
      })
      await expect
        .poll(async () => (await layoutInfo(page, auxGroupId))?.container.width ?? 0)
        .toBeLessThan(initial.container.width - 80)

      // Grow past the original size. Before the fix, Monaco's layout stays at
      // the pre-pause size while the container grows.
      await setSize(electronApp, auxWindowId, {
        width: auxBounds.width + 160,
        height: auxBounds.height + 120,
      })
      await expect
        .poll(async () => (await layoutInfo(page, auxGroupId))?.container.width ?? 0)
        .toBeGreaterThan(initial.container.width + 100)
      await expect
        .poll(() => layoutMismatch(page, auxGroupId), {
          timeout: 3000,
          message: 'Monaco layout must follow the auxiliary editor container after resize',
        })
        .toBeLessThanOrEqual(1)

      const resized = (await layoutInfo(page, auxGroupId))!
      expect(resized.layout.width).toBeGreaterThan(initial.layout.width + 100)
      expect(resized.layout.height).toBeGreaterThan(initial.layout.height + 80)
    } finally {
      if (cdp) {
        await cdp
          .send('Emulation.setVirtualTimePolicy', { policy: 'advance' })
          .catch(() => undefined)
        await cdp.detach().catch(() => undefined)
      }
      await page
        .evaluate(() => {
          ;(window as RafProbeWindow).__ueRafStop = true
        })
        .catch(() => undefined)
      await page
        .evaluate((token) => window.__E2E__!.requestCloseAuxiliaryWindow(token), auxSnapshot.token)
        .catch(() => undefined)
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getAuxiliaryWindows().length))
        .toBe(0)
        .catch(() => undefined)
    }
  })
})
