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
 *  停止主窗口渲染的机制：生产里由辅助窗口最大化后的遮挡触发。e2e 里 hide()/minimize()
 *  在 backgroundThrottling=false 下不会让 WebContents 进入 hidden（实测 visibilityState
 *  恒为 VISIBLE），Page.setWebLifecycleState('frozen') 同样不停帧。CDP 虚拟时间暂停是唯一
 *  能可靠停掉主 frame 的手段，但它是 renderer 进程级的：Windows 上主/辅助窗口共享同一个
 *  renderer 进程（`webContents.getOSProcessId()` 相同），暂停后辅助窗口的 rAF、ResizeObserver
 *  投递与窗口 resize 也一起冻结（实测主 realm/子 realm rAF 计数同时停住；aux 容器在 grow
 *  后不再更新）。因此「暂停期间让辅助窗口继续布局」是非法的前提，不能用它断言尺寸同步。
 *
 *  本用例因此分两层守护：
 *    1. realm 归属（根因，旧 patch 必挂）：移动编辑器前给主 realm 的 ResizeObserver 装上探针，
 *       断言它从未 observe 辅助 document 里的 `[data-testid="file-editor"]`（旧代码会在这里
 *       观察到该元素）；同时断言辅助 realm 的探针观察到了它。
 *    2. 主帧停止守卫 + 功能回归：CDP 暂停并确认主 frame 真的停帧；恢复后对辅助窗口
 *       shrink/grow，断言 Monaco layout 跟随容器。
 *  尺寸变化用 setBounds 确定性触发（xvfb 下 maximize() 是 no-op）。
 *--------------------------------------------------------------------------------------------*/

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CDPSession, ElectronApplication, Page } from '@playwright/test'
import { test, expect } from '../fixtures/electronApp.js'

/** 观察窗口是否还在产生帧；400ms 是「确认不前进」的观察窗，不是等待条件。 */
const FRAME_GUARD_MS = 400

type RafProbeWindow = Window & { __ueRafTicks?: number; __ueRafStop?: boolean }

interface RoObservation {
  /** True when the observed element belongs to the document of the probing realm. */
  ownerIsSameDocument: boolean
  testId: string
}

interface RoProbe {
  observed: RoObservation[]
}

type RoProbeWindow = Window & {
  __ueRo?: RoProbe
  __ueRoNative?: typeof ResizeObserver
}

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

// 必须在编辑器挂载前于目标 realm 执行，document 才能标识 observer 的归属。
function installResizeObserverProbe(): void {
  const probe = window as RoProbeWindow
  const Native = window.ResizeObserver
  probe.__ueRoNative = Native
  probe.__ueRo = { observed: [] }
  class TrackingResizeObserver extends Native {
    override observe(target: Element, options?: ResizeObserverOptions): void {
      probe.__ueRo!.observed.push({
        ownerIsSameDocument: target.ownerDocument === document,
        testId: target.getAttribute('data-testid') ?? '',
      })
      super.observe(target, options)
    }
  }
  window.ResizeObserver = TrackingResizeObserver

  // 即使之后没有主 realm observer，也必须证明探针已安装。
  const selfTarget = document.createElement('div')
  selfTarget.setAttribute('data-testid', 'ro-probe-self')
  const selfObserver = new window.ResizeObserver(() => {})
  selfObserver.observe(selfTarget)
  selfObserver.disconnect()
  selfTarget.remove()
}

async function readResizeObserverProbe(page: Page): Promise<RoProbe> {
  return page.evaluate(() => (window as RoProbeWindow).__ueRo ?? { observed: [] })
}

async function restoreResizeObserverProbe(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      const probe = window as RoProbeWindow
      if (probe.__ueRoNative) window.ResizeObserver = probe.__ueRoNative
      delete probe.__ueRoNative
      delete probe.__ueRo
    })
    .catch(() => undefined)
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

    // 在弹窗脚本运行前安装，避免 window 事件后的 CDP 调用与编辑器挂载竞速。
    await page.context().addInitScript(installResizeObserverProbe)
    await page.evaluate(installResizeObserverProbe)

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
      // Stop the main frame. The guard below fails hard if it keeps ticking,
      // otherwise the reproduction precondition would silently disappear.
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

      // Root-cause guard: the auxiliary editor's container must be observed by
      // the auxiliary realm's ResizeObserver, never by the (now stopped) main
      // realm's. The old bare `new ResizeObserver(...)` fails this assertion.
      const mainProbe = await readResizeObserverProbe(page)
      const childProbe = await readResizeObserverProbe(child)
      expect(
        mainProbe.observed.some(
          (observation) =>
            observation.testId === 'ro-probe-self' && observation.ownerIsSameDocument,
        ),
        'main-realm ResizeObserver probe must be active',
      ).toBe(true)
      expect(
        childProbe.observed.some(
          (observation) =>
            observation.testId === 'ro-probe-self' && observation.ownerIsSameDocument,
        ),
        'auxiliary-realm ResizeObserver probe must be active',
      ).toBe(true)
      expect(
        mainProbe.observed.filter(
          (observation) => observation.testId === 'file-editor' && !observation.ownerIsSameDocument,
        ),
        'Monaco must not observe the auxiliary editor container with the main realm ResizeObserver',
      ).toEqual([])
      expect(
        childProbe.observed.some(
          (observation) => observation.testId === 'file-editor' && observation.ownerIsSameDocument,
        ),
        'the auxiliary realm ResizeObserver must observe the editor container',
      ).toBe(true)

      // Resume before the functional resize: virtual-time pause freezes the
      // shared renderer process (on Windows the aux window has the same pid), so
      // aux layout cannot progress while main is paused.
      await cdp.send('Emulation.setVirtualTimePolicy', { policy: 'advance' })

      // Shrink first, then grow past the original size. Both must be reflected
      // by Monaco's layout, not just by the container box.
      await setSize(electronApp, auxWindowId, {
        width: auxBounds.width - 140,
        height: auxBounds.height - 120,
      })
      await expect
        .poll(async () => (await layoutInfo(page, auxGroupId))?.container.width ?? 0)
        .toBeLessThan(initial.container.width - 80)
      await expect
        .poll(() => layoutMismatch(page, auxGroupId), {
          message: 'Monaco layout must follow the auxiliary editor container after shrinking',
        })
        .toBeLessThanOrEqual(1)

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
      await restoreResizeObserverProbe(page)
      await restoreResizeObserverProbe(child)
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
