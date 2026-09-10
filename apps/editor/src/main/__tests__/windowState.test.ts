/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/windowState.ts
 *  Reproduction for: closing maximized on the primary monitor, the next launch
 *  maximized onto the SECONDARY. Root cause: we used Electron's displayId as the
 *  cross-session monitor identity, but displayId drifts between sessions
 *  (especially under WSLg where the X11 RANDR id space reallocates). Fix:
 *  persist displayBounds alongside displayId and match by bounds first.
 *--------------------------------------------------------------------------------------------*/

import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

interface FakeDisplay {
  id: number
  bounds: { x: number; y: number; width: number; height: number }
  workArea: { x: number; y: number; width: number; height: number }
}

// Two side-by-side 2560x1440 monitors, mimicking the user's WSLg dual-monitor rig.
// ids deliberately differ from any persisted legacy value to simulate id drift.
const PRIMARY: FakeDisplay = {
  id: 33,
  bounds: { x: 0, y: 0, width: 2560, height: 1440 },
  workArea: { x: 0, y: 0, width: 2560, height: 1440 },
}
const SECONDARY: FakeDisplay = {
  id: 1,
  bounds: { x: 2560, y: 0, width: 2560, height: 1440 },
  workArea: { x: 2560, y: 0, width: 2560, height: 1440 },
}

let allDisplays: FakeDisplay[] = []

vi.mock('electron', () => ({
  screen: {
    getAllDisplays: () => allDisplays,
    getDisplayNearestPoint: (pt: { x: number; y: number }) => {
      const hit = allDisplays.find(
        (d) =>
          pt.x >= d.bounds.x &&
          pt.x < d.bounds.x + d.bounds.width &&
          pt.y >= d.bounds.y &&
          pt.y < d.bounds.y + d.bounds.height,
      )
      return hit ?? allDisplays[0]
    },
    getPrimaryDisplay: () => allDisplays[0],
  },
}))

const { captureWindowState, applyWindowState, validateWindowState } =
  await import('../windowState.js')

class FakeWindow extends EventEmitter {
  readonly id = 1
  private _maximized = false
  private _fullscreen = false
  private _destroyed = false
  bounds = { x: 0, y: 0, width: 1280, height: 800 }

  isMaximized(): boolean {
    return this._maximized
  }
  isFullScreen(): boolean {
    return this._fullscreen
  }
  isDestroyed(): boolean {
    return this._destroyed
  }
  getBounds() {
    return this.bounds
  }
  getNormalBounds() {
    return this.bounds
  }
  setPosition(x: number, y: number): void {
    this.bounds = { ...this.bounds, x, y }
  }
  setFullScreen(flag: boolean): void {
    this._fullscreen = flag
  }
  maximize(): void {
    this._maximized = true
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  asWin(): any {
    return this
  }
}

describe('windowState.applyWindowState — display identity across sessions', () => {
  beforeEach(() => {
    allDisplays = [PRIMARY, SECONDARY]
  })

  it('matches the saved display by bounds when displayId has drifted', () => {
    const win = new FakeWindow()
    // Saved last session on PRIMARY (x:0, w:2560). Since then the session restarted
    // and PRIMARY's id changed from 11 → 33. The persisted normal-bounds (x:402,y:428)
    // happens to land on SECONDARY.
    const saved = validateWindowState({
      x: 402,
      y: 428,
      width: 1280,
      height: 800,
      isMaximized: true,
      isFullscreen: false,
      displayId: 11, // stale — no current display has this id
      displayBounds: { x: 0, y: 0, width: 2560, height: 1440 },
    })!
    expect(saved).toBeDefined()

    applyWindowState(win.asWin(), saved)

    // Fix behavior: setPosition must have moved the window back onto PRIMARY's bounds
    // BEFORE maximize() — otherwise maximize lands on SECONDARY.
    expect(win.bounds.x).toBeGreaterThanOrEqual(PRIMARY.bounds.x)
    expect(win.bounds.x).toBeLessThan(PRIMARY.bounds.x + PRIMARY.bounds.width)
    expect(win.bounds.y).toBeGreaterThanOrEqual(PRIMARY.bounds.y)
    expect(win.bounds.y).toBeLessThan(PRIMARY.bounds.y + PRIMARY.bounds.height)
    expect(win.isMaximized()).toBe(true)
  })

  it('keeps the restore on SECONDARY when displayBounds says so, even if (x,y) looks primary', () => {
    const win = new FakeWindow()
    // User maximized on SECONDARY last time, but their persisted normal-bounds
    // (x:402,y:428 — the pre-maximize restore rect) is on PRIMARY. displayBounds
    // tells the truth: target is SECONDARY.
    const saved = validateWindowState({
      x: 402,
      y: 428,
      width: 1280,
      height: 800,
      isMaximized: true,
      isFullscreen: false,
      displayId: 99, // stale
      displayBounds: { x: 2560, y: 0, width: 2560, height: 1440 },
    })!

    applyWindowState(win.asWin(), saved)

    expect(win.bounds.x).toBeGreaterThanOrEqual(SECONDARY.bounds.x)
    expect(win.bounds.x).toBeLessThan(SECONDARY.bounds.x + SECONDARY.bounds.width)
    expect(win.isMaximized()).toBe(true)
  })

  it('falls back to legacy displayId when displayBounds is absent (back-compat)', () => {
    const win = new FakeWindow()
    // Pre-fix state.json: only displayId, no displayBounds. id 33 matches PRIMARY.
    const saved = validateWindowState({
      x: 402,
      y: 428,
      width: 1280,
      height: 800,
      isMaximized: true,
      isFullscreen: false,
      displayId: 33,
    })!

    applyWindowState(win.asWin(), saved)

    // Should land on PRIMARY (via legacy displayId) even though (402,428) sits on SECONDARY.
    expect(win.bounds.x).toBeGreaterThanOrEqual(PRIMARY.bounds.x)
    expect(win.bounds.x).toBeLessThan(PRIMARY.bounds.x + PRIMARY.bounds.width)
    expect(win.isMaximized()).toBe(true)
  })

  it('leaves the window alone when (x,y) is already on the target display', () => {
    const win = new FakeWindow()
    const setPositionSpy = vi.spyOn(win, 'setPosition')
    // (402,428) is on PRIMARY; saved displayBounds = PRIMARY → no setPosition needed.
    const saved = validateWindowState({
      x: 402,
      y: 428,
      width: 1280,
      height: 800,
      isMaximized: true,
      isFullscreen: false,
      displayId: 33,
      displayBounds: { x: 0, y: 0, width: 2560, height: 1440 },
    })!

    applyWindowState(win.asWin(), saved)

    expect(setPositionSpy).not.toHaveBeenCalled()
    expect(win.isMaximized()).toBe(true)
  })

  it('maximizes in place when no saved display matches anything current', () => {
    const win = new FakeWindow()
    // Unplugged monitor: displayBounds matches nothing, legacy displayId matches nothing.
    const saved = validateWindowState({
      x: 402,
      y: 428,
      width: 1280,
      height: 800,
      isMaximized: true,
      isFullscreen: false,
      displayId: 999,
      displayBounds: { x: 9999, y: 9999, width: 1920, height: 1080 },
    })!

    applyWindowState(win.asWin(), saved)

    // Falls through: no setPosition (target unknown), maximize wherever (x,y) landed.
    expect(win.isMaximized()).toBe(true)
  })
})

describe('windowState.captureWindowState', () => {
  beforeEach(() => {
    allDisplays = [PRIMARY, SECONDARY]
  })

  it('records both displayId (legacy) and displayBounds (new identity)', () => {
    const win = new FakeWindow()
    // Park the window's center on SECONDARY.
    win.bounds = { x: 2560 + 100, y: 100, width: 1280, height: 800 }
    const state = captureWindowState(win.asWin())
    expect(state.displayId).toBe(SECONDARY.id)
    expect(state.displayBounds).toEqual(SECONDARY.bounds)
  })
})
