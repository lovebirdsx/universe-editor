/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Pure window geometry for cross-window `workbench.action.navigate*`.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { IWorkbenchWindow } from '../../windows/workbenchWindowService.js'
import {
  findWindowInDirection,
  isWindowNavigable,
  offsetRectToScreen,
  windowScreenRect,
} from '../windowDirection.js'

interface WindowOptions {
  readonly id?: number
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly closed?: boolean
  readonly visibilityState?: DocumentVisibilityState
}

function fakeWindow(options: WindowOptions): IWorkbenchWindow {
  return {
    id: options.id ?? 1,
    isMain: false,
    part: undefined,
    document: { visibilityState: options.visibilityState ?? 'visible' },
    window: {
      screenX: options.x,
      screenY: options.y,
      outerWidth: options.width,
      outerHeight: options.height,
      closed: options.closed ?? false,
    },
    token: `token-${options.id ?? 1}`,
  } as unknown as IWorkbenchWindow
}

const ORIGIN = { left: 100, top: 100, right: 300, bottom: 300 }

describe('windowScreenRect', () => {
  it('maps native window bounds to a screen rect', () => {
    expect(windowScreenRect(fakeWindow({ x: 320, y: 40, width: 800, height: 600 }))).toEqual({
      left: 320,
      top: 40,
      right: 1120,
      bottom: 640,
    })
  })

  it('keeps negative coordinates for displays left of the primary one', () => {
    expect(windowScreenRect(fakeWindow({ x: -900, y: -50, width: 800, height: 600 }))).toEqual({
      left: -900,
      top: -50,
      right: -100,
      bottom: 550,
    })
  })

  it('rejects non-finite or empty bounds', () => {
    expect(
      windowScreenRect(fakeWindow({ x: Number.NaN, y: 0, width: 800, height: 600 })),
    ).toBeUndefined()
    expect(
      windowScreenRect(fakeWindow({ x: 0, y: Number.POSITIVE_INFINITY, width: 800, height: 600 })),
    ).toBeUndefined()
    expect(windowScreenRect(fakeWindow({ x: 0, y: 0, width: 0, height: 600 }))).toBeUndefined()
    expect(windowScreenRect(fakeWindow({ x: 0, y: 0, width: 800, height: -1 }))).toBeUndefined()
  })
})

describe('offsetRectToScreen', () => {
  it('adds the window origin to a viewport rect', () => {
    const win = fakeWindow({ x: 50, y: 60, width: 800, height: 600 })
    expect(offsetRectToScreen({ left: 0, top: 0, right: 200, bottom: 500 }, win)).toEqual({
      left: 50,
      top: 60,
      right: 250,
      bottom: 560,
    })
  })

  it('returns undefined when the window origin is not usable', () => {
    const win = fakeWindow({ x: Number.NaN, y: 0, width: 800, height: 600 })
    expect(offsetRectToScreen(ORIGIN, win)).toBeUndefined()
  })
})

describe('isWindowNavigable', () => {
  it('accepts a visible, live window', () => {
    expect(isWindowNavigable(fakeWindow({ x: 0, y: 0, width: 800, height: 600 }))).toBe(true)
  })

  it('rejects closed, hidden and zero-sized windows', () => {
    expect(
      isWindowNavigable(fakeWindow({ x: 0, y: 0, width: 800, height: 600, closed: true })),
    ).toBe(false)
    expect(
      isWindowNavigable(
        fakeWindow({ x: 0, y: 0, width: 800, height: 600, visibilityState: 'hidden' }),
      ),
    ).toBe(false)
    expect(isWindowNavigable(fakeWindow({ x: 0, y: 0, width: 0, height: 600 }))).toBe(false)
  })
})

describe('findWindowInDirection', () => {
  const left = fakeWindow({ id: 2, x: -100, y: 100, width: 180, height: 200 })
  const right = fakeWindow({ id: 3, x: 320, y: 100, width: 300, height: 200 })
  const up = fakeWindow({ id: 4, x: 100, y: -100, width: 200, height: 180 })
  const down = fakeWindow({ id: 5, x: 100, y: 320, width: 200, height: 300 })
  const all = [left, right, up, down]

  it('finds a window in each direction', () => {
    expect(findWindowInDirection(1, ORIGIN, all, 'left')).toBe(left)
    expect(findWindowInDirection(1, ORIGIN, all, 'right')).toBe(right)
    expect(findWindowInDirection(1, ORIGIN, all, 'up')).toBe(up)
    expect(findWindowInDirection(1, ORIGIN, all, 'down')).toBe(down)
  })

  it('skips the active window', () => {
    const self = fakeWindow({ id: 1, x: 320, y: 100, width: 300, height: 200 })
    expect(findWindowInDirection(1, ORIGIN, [self, right], 'right')).toBe(right)
    expect(findWindowInDirection(1, ORIGIN, [self], 'right')).toBeUndefined()
  })

  it('skips hidden, closed and empty windows', () => {
    const hidden = fakeWindow({
      id: 6,
      x: 320,
      y: 100,
      width: 300,
      height: 200,
      visibilityState: 'hidden',
    })
    const closed = fakeWindow({ id: 7, x: 320, y: 100, width: 300, height: 200, closed: true })
    const empty = fakeWindow({ id: 8, x: 320, y: 100, width: 0, height: 200 })
    expect(findWindowInDirection(1, ORIGIN, [hidden, closed, empty], 'right')).toBeUndefined()
    expect(findWindowInDirection(1, ORIGIN, [hidden, right], 'right')).toBe(right)
  })

  it('picks the nearest window in the direction', () => {
    const far = fakeWindow({ id: 9, x: 900, y: 100, width: 300, height: 200 })
    expect(findWindowInDirection(1, ORIGIN, [far, right], 'right')).toBe(right)
  })

  it('prefers the larger perpendicular overlap when the gaps tie', () => {
    const narrow = fakeWindow({ id: 10, x: 320, y: 100, width: 200, height: 100 })
    const tall = fakeWindow({ id: 11, x: 320, y: 0, width: 200, height: 300 })
    expect(findWindowInDirection(1, ORIGIN, [narrow, tall], 'right')).toBe(tall)
  })

  it('ignores diagonal windows without perpendicular overlap', () => {
    const diagonal = fakeWindow({ id: 12, x: 320, y: 500, width: 300, height: 200 })
    expect(findWindowInDirection(1, ORIGIN, [diagonal], 'right')).toBeUndefined()
  })

  it('returns undefined at the edge of the screen layout', () => {
    expect(findWindowInDirection(1, ORIGIN, [], 'right')).toBeUndefined()
  })
})
