/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/host/hostMainService.ts
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { relaunch, quit, showSaveDialog, showOpenDialog, notificationState } = vi.hoisted(() => ({
  relaunch: vi.fn(),
  quit: vi.fn(),
  showSaveDialog: vi.fn(),
  showOpenDialog: vi.fn(),
  notificationState: {
    supported: true,
    instances: [] as Array<{
      opts: { title: string; body: string }
      emit(event: 'click' | 'close' | 'failed'): void
      shown: boolean
    }>,
  },
}))

vi.mock('electron', async () => {
  const actual = await vi.importActual<typeof import('electron')>('electron')
  class NotificationMock {
    static isSupported(): boolean {
      return notificationState.supported
    }
    private readonly _handlers: Record<string, Array<() => void>> = {}
    shown = false
    constructor(readonly opts: { title: string; body: string }) {
      notificationState.instances.push(this)
    }
    on(event: string, handler: () => void): this {
      ;(this._handlers[event] ??= []).push(handler)
      return this
    }
    show(): void {
      this.shown = true
    }
    emit(event: 'click' | 'close' | 'failed'): void {
      this._handlers[event]?.forEach((h) => h())
    }
  }
  return {
    ...actual,
    app: {
      relaunch,
      quit,
    },
    dialog: {
      showSaveDialog,
      showOpenDialog,
    },
    Notification: NotificationMock,
  }
})

import { MainHostService } from '../../services/host/hostMainService.js'

interface FakeWin {
  isMaximized(): boolean
  minimize(): void
  maximize(): void
  unmaximize(): void
  close(): void
  reload(): void
  on(event: string, handler: () => void): void
  removeListener(event: string, handler: () => void): void
  isDestroyed(): boolean
  isFocused(): boolean
  isMinimized(): boolean
  restore(): void
  show(): void
  focus(): void
  moveTop(): void
  setAlwaysOnTop(flag: boolean): void
  flashFrame(flag: boolean): void
  readonly id: number
  readonly webContents: { toggleDevTools(): void }
  __fire(event: 'maximize' | 'unmaximize'): void
  __setFocused(focused: boolean): void
}

function makeFakeWin(): FakeWin & { calls: string[] } {
  const calls: string[] = []
  const listeners: Record<string, (() => void)[]> = { maximize: [], unmaximize: [] }
  let maximized = false
  let focused = false
  let minimized = false
  const fake: FakeWin & { calls: string[] } = {
    calls,
    id: 1,
    isMaximized() {
      return maximized
    },
    minimize() {
      minimized = true
      calls.push('minimize')
    },
    maximize() {
      maximized = true
      calls.push('maximize')
      listeners.maximize?.forEach((h) => h())
    },
    unmaximize() {
      maximized = false
      calls.push('unmaximize')
      listeners.unmaximize?.forEach((h) => h())
    },
    close() {
      calls.push('close')
    },
    reload() {
      calls.push('reload')
    },
    isFocused() {
      return focused
    },
    isMinimized() {
      return minimized
    },
    restore() {
      minimized = false
      calls.push('restore')
    },
    show() {
      calls.push('show')
    },
    focus() {
      focused = true
      calls.push('focus')
    },
    moveTop() {
      calls.push('moveTop')
    },
    setAlwaysOnTop(flag) {
      calls.push(`setAlwaysOnTop:${flag}`)
    },
    flashFrame(flag) {
      calls.push(`flashFrame:${flag}`)
    },
    webContents: {
      toggleDevTools() {
        calls.push('toggleDevTools')
      },
    },
    on(event, handler) {
      const arr = listeners[event] ?? (listeners[event] = [])
      arr.push(handler)
    },
    removeListener(event, handler) {
      const arr = listeners[event]
      if (!arr) return
      const idx = arr.indexOf(handler)
      if (idx >= 0) arr.splice(idx, 1)
    },
    isDestroyed() {
      return false
    },
    __fire(event) {
      listeners[event]?.forEach((h) => h())
    },
    __setFocused(value) {
      focused = value
    },
  }
  return fake
}

describe('MainHostService', () => {
  beforeEach(() => {
    relaunch.mockReset()
    quit.mockReset()
    showSaveDialog.mockReset()
    showOpenDialog.mockReset()
    notificationState.supported = true
    notificationState.instances.length = 0
    vi.unstubAllEnvs()
  })

  it('isMaximized reflects underlying window state', async () => {
    const win = makeFakeWin()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new MainHostService(win as any)
    await expect(service.isMaximized()).resolves.toBe(false)
    win.maximize()
    await expect(service.isMaximized()).resolves.toBe(true)
    service.dispose()
  })

  it('method calls delegate to the window', async () => {
    const win = makeFakeWin()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new MainHostService(win as any)
    await service.minimizeWindow()
    await service.toggleMaximizeWindow()
    await service.toggleMaximizeWindow()
    await service.closeWindow()
    expect(win.calls).toEqual(['minimize', 'maximize', 'unmaximize', 'close'])
    service.dispose()
  })

  it('onDidChangeMaximized fires on maximize / unmaximize events', () => {
    const win = makeFakeWin()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new MainHostService(win as any)
    const events: boolean[] = []
    service.onDidChangeMaximized((v: boolean) => events.push(v))
    win.maximize()
    win.unmaximize()
    expect(events).toEqual([true, false])
    service.dispose()
  })

  it('toggleDevTools delegates to webContents.toggleDevTools', async () => {
    const win = makeFakeWin()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new MainHostService(win as any)
    await service.toggleDevTools()
    expect(win.calls).toEqual(['toggleDevTools'])
    service.dispose()
  })

  it('restart relaunches the app and then quits', async () => {
    const win = makeFakeWin()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new MainHostService(win as any)
    await service.restart()
    expect(relaunch).toHaveBeenCalledTimes(1)
    expect(quit).toHaveBeenCalledTimes(1)
    expect(relaunch.mock.invocationCallOrder[0]).toBeLessThan(quit.mock.invocationCallOrder[0]!)
    service.dispose()
  })

  it('restart reloads the current window in dev mode', async () => {
    const win = makeFakeWin()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new MainHostService(win as any, undefined, undefined, true)
    await service.restart()
    expect(win.calls).toEqual(['reload'])
    expect(relaunch).not.toHaveBeenCalled()
    expect(quit).not.toHaveBeenCalled()
    service.dispose()
  })

  it('showSaveFileDialog returns null when dialog is cancelled', async () => {
    showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined })
    const win = makeFakeWin()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new MainHostService(win as any)
    const result = await service.showSaveFileDialog({ defaultPath: 'F:/test/test/Untitled-1.txt' })
    expect(result).toBeNull()
    service.dispose()
  })

  it('showSaveFileDialog normalizes forward-slash defaultPath before passing to dialog', async () => {
    showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined })
    const win = makeFakeWin()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new MainHostService(win as any)
    await service.showSaveFileDialog({ defaultPath: 'F:/test/test/Untitled-1.txt' })
    const [, opts] = showSaveDialog.mock.calls[0] as [unknown, { defaultPath: string }]
    // path.normalize converts forward slashes to the OS separator; on Windows
    // this produces backslashes so the native shell dialog finds the directory.
    // On POSIX the path is returned unchanged, so the assertion uses path.normalize.
    const { normalize } = await import('node:path')
    expect(opts.defaultPath).toBe(normalize('F:/test/test/Untitled-1.txt'))
    service.dispose()
  })

  it('showSaveFileDialog returns URI for the picked file path', async () => {
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: 'F:\\test\\test\\output.txt' })
    const win = makeFakeWin()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new MainHostService(win as any)
    const result = await service.showSaveFileDialog({})
    expect(result).not.toBeNull()
    expect(result?.scheme).toBe('file')
    expect(result?.path).toBe('/F:/test/test/output.txt')
    service.dispose()
  })

  it('showOpenFileDialog returns null when dialog is cancelled', async () => {
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    const win = makeFakeWin()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new MainHostService(win as any)
    const result = await service.showOpenFileDialog({ defaultPath: 'F:/test/test/' })
    expect(result).toBeNull()
    service.dispose()
  })

  it('showOpenFileDialog normalizes forward-slash defaultPath before passing to dialog', async () => {
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    const win = makeFakeWin()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new MainHostService(win as any)
    await service.showOpenFileDialog({ defaultPath: 'F:/test/test/' })
    const [, opts] = showOpenDialog.mock.calls[0] as [unknown, { defaultPath: string }]
    const { normalize } = await import('node:path')
    expect(opts.defaultPath).toBe(normalize('F:/test/test/'))
    service.dispose()
  })

  describe('notify', () => {
    it('is suppressed while the window is focused (default gating)', async () => {
      const win = makeFakeWin()
      win.__setFocused(true)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const service = new MainHostService(win as any)
      const result = await service.notify({ title: 'Done', body: 'finished' })
      expect(result).toEqual({ shown: false, clicked: false })
      expect(notificationState.instances).toHaveLength(0)
      service.dispose()
    })

    it('shows when blurred and resolves clicked:true on click', async () => {
      const win = makeFakeWin()
      win.__setFocused(false)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const service = new MainHostService(win as any)
      const pending = service.notify({ title: 'Permission', body: 'needs you' })
      expect(notificationState.instances).toHaveLength(1)
      const notif = notificationState.instances[0]!
      expect(notif.opts).toEqual({ title: 'Permission', body: 'needs you' })
      notif.emit('click')
      await expect(pending).resolves.toEqual({ shown: true, clicked: true })
      service.dispose()
    })

    it('resolves clicked:false when dismissed', async () => {
      const win = makeFakeWin()
      win.__setFocused(false)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const service = new MainHostService(win as any)
      const pending = service.notify({ title: 'Q', body: 'asks you' })
      notificationState.instances[0]!.emit('close')
      await expect(pending).resolves.toEqual({ shown: true, clicked: false })
      service.dispose()
    })

    it('still shows when focused if onlyWhenBlurred is false', async () => {
      const win = makeFakeWin()
      win.__setFocused(true)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const service = new MainHostService(win as any)
      const pending = service.notify({ title: 'X', body: 'y', onlyWhenBlurred: false })
      expect(notificationState.instances).toHaveLength(1)
      notificationState.instances[0]!.emit('close')
      await expect(pending).resolves.toEqual({ shown: true, clicked: false })
      service.dispose()
    })

    it('degrades gracefully when notifications are unsupported', async () => {
      notificationState.supported = false
      const win = makeFakeWin()
      win.__setFocused(false)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const service = new MainHostService(win as any)
      const result = await service.notify({ title: 'X', body: 'y' })
      expect(result).toEqual({ shown: false, clicked: false })
      expect(notificationState.instances).toHaveLength(0)
      service.dispose()
    })
  })

  describe('focusWindow', () => {
    it('restores a minimized window and brings it to the foreground', async () => {
      const win = makeFakeWin()
      win.minimize()
      win.calls.length = 0
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const service = new MainHostService(win as any)
      await service.focusWindow()
      expect(win.calls).toContain('restore')
      expect(win.calls).toContain('show')
      expect(win.calls).toContain('focus')
      service.dispose()
    })
  })
})
