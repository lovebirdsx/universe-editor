/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Cross-window focus routing: main vs auxiliary IPC targets, the DOM-focus
 *  guard and failure isolation.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import type { IEditorGroup, IEditorPart } from '@universe-editor/platform'
import type { IAuxiliaryWindowsService } from '../../../../shared/ipc/auxiliaryWindowService.js'
import { WindowFocusService } from '../windowFocusService.js'
import { WorkbenchWindowService } from '../workbenchWindowService.js'

function fakeDocument(hasFocus: boolean | (() => boolean)): Document {
  return {
    hasFocus: typeof hasFocus === 'function' ? hasFocus : () => hasFocus,
    addEventListener() {},
    removeEventListener() {},
    defaultView: {
      addEventListener() {},
      removeEventListener() {},
    },
  } as unknown as Document
}

function fakeWindow(doc: Document): Window {
  return {
    document: doc,
    addEventListener() {},
    removeEventListener() {},
  } as unknown as Window
}

function makePart(id: number): IEditorPart {
  return { id } as unknown as IEditorPart
}

function makeGroup(part: IEditorPart): IEditorGroup {
  return { part } as unknown as IEditorGroup
}

function setup(hasMainFocus = false) {
  const windows = new WorkbenchWindowService()
  const mainPart = makePart(1)
  const mainDoc = fakeDocument(hasMainFocus)
  windows.registerMainWindow(mainPart, mainDoc)
  const windowsService = {
    _serviceBrand: undefined,
    getCurrentWindowId: vi.fn(async () => 42),
    focusWindow: vi.fn(async () => {}),
  }
  const aux = {
    _serviceBrand: undefined,
    focusWindow: vi.fn(async () => {}),
  }
  const service = new WindowFocusService(
    windows,
    windowsService as never,
    aux as unknown as IAuxiliaryWindowsService,
    { debug: vi.fn() } as never,
  )
  return { windows, windowsService, aux, service, mainPart, mainDoc }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('WindowFocusService', () => {
  it('requests main-window OS focus through the windows service', async () => {
    const ctx = setup()

    ctx.service.focusGroup(makeGroup(ctx.mainPart))
    await flush()

    expect(ctx.windowsService.getCurrentWindowId).toHaveBeenCalledTimes(1)
    expect(ctx.windowsService.focusWindow).toHaveBeenCalledWith(42)
    expect(ctx.aux.focusWindow).not.toHaveBeenCalled()
    // Renderer-side activation must be updated even when the native call is async.
    expect(ctx.windows.activeWindow.isMain).toBe(true)
  })

  it('caches the current window id and dedupes overlapping requests', async () => {
    const ctx = setup()

    ctx.service.focusGroup(makeGroup(ctx.mainPart))
    ctx.service.focusGroup(makeGroup(ctx.mainPart))
    await flush()

    expect(ctx.windowsService.getCurrentWindowId).toHaveBeenCalledTimes(1)
    // The second call happened while the first IPC was in flight.
    expect(ctx.windowsService.focusWindow).toHaveBeenCalledTimes(1)

    ctx.service.focusGroup(makeGroup(ctx.mainPart))
    await flush()
    expect(ctx.windowsService.focusWindow).toHaveBeenCalledTimes(2)
  })

  it('skips the native call when the document already has focus', async () => {
    const ctx = setup(true)

    ctx.service.focusGroup(makeGroup(ctx.mainPart))
    await flush()

    expect(ctx.windowsService.focusWindow).not.toHaveBeenCalled()
  })

  it('routes auxiliary windows through their capability token', async () => {
    const ctx = setup()
    const auxPart = makePart(9)
    const auxDoc = fakeDocument(false)
    ctx.windows.registerAuxiliaryWindow(auxPart, fakeWindow(auxDoc), 'token-9')

    ctx.service.focusGroup(makeGroup(auxPart))
    await flush()

    expect(ctx.aux.focusWindow).toHaveBeenCalledWith('token-9')
    expect(ctx.windowsService.focusWindow).not.toHaveBeenCalled()
    expect(ctx.windows.activeWindow.token).toBe('token-9')
  })

  it('swallows IPC failures and retries the id lookup on the next call', async () => {
    const ctx = setup()
    ctx.windowsService.getCurrentWindowId.mockRejectedValueOnce(new Error('ipc gone'))

    ctx.service.focusMainWindow()
    await flush()
    ctx.service.focusMainWindow()
    await flush()

    expect(ctx.windowsService.getCurrentWindowId).toHaveBeenCalledTimes(2)
    expect(ctx.windowsService.focusWindow).toHaveBeenCalledTimes(1)
  })

  it('swallows auxiliary focus IPC failures', async () => {
    const ctx = setup()
    const auxPart = makePart(9)
    ctx.windows.registerAuxiliaryWindow(auxPart, fakeWindow(fakeDocument(false)), 'token-9')
    ctx.aux.focusWindow.mockRejectedValueOnce(new Error('window closed'))

    expect(() => ctx.service.focusGroup(makeGroup(auxPart))).not.toThrow()
    await flush()
    expect(ctx.aux.focusWindow).toHaveBeenCalledWith('token-9')
  })

  it('treats a throwing hasFocus probe as unfocused', async () => {
    const ctx = setup()
    const mainDoc = ctx.mainDoc as unknown as { hasFocus: () => boolean }
    mainDoc.hasFocus = () => {
      throw new Error('destroyed')
    }

    ctx.service.focusMainWindow()
    await flush()

    expect(ctx.windowsService.focusWindow).toHaveBeenCalledWith(42)
  })
})
