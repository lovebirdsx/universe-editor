/*---------------------------------------------------------------------------------------------
 *  Failure-path tests for the auxiliary window service: creation cleanup,
 *  move/copy revalidation, close veto and salvage ownership.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EditorInput,
  EditorRegistry,
  Emitter,
  Event,
  GroupDirection,
  InstantiationService,
  ServiceCollection,
  URI,
  localize,
  type ILoggerService,
  type INotificationService,
  type IEditorGroupsService,
} from '@universe-editor/platform'
import {
  AUXILIARY_WINDOW_MARKER_KEY,
  type IAuxiliaryWindowsService,
  type PreparedAuxiliaryWindow,
} from '../../../../shared/ipc/auxiliaryWindowService.js'
import { EditorGroupsService } from '../../editor/EditorGroupsService.js'
import { WorkbenchWindowService } from '../workbenchWindowService.js'
import { AuxiliaryEditorWindowService } from '../auxiliaryEditorWindowService.js'
import type { IAuxiliaryEditorWindow } from '../auxiliaryEditorWindowService.js'
import { FakeWindowFocusService } from '../testing/fakeWindowFocusService.js'
import { getWorkbenchDocuments } from '../workbenchDocuments.js'

vi.mock('../monacoWindowRegistration.js', () => ({
  registerMonacoWindow: vi.fn(async () => ({ dispose: () => {} })),
}))

class TestInput extends EditorInput {
  static readonly TYPE_ID = 'aux.test'
  constructor(private readonly _path: string) {
    super()
  }
  get typeId(): string {
    return TestInput.TYPE_ID
  }
  get resource(): URI {
    return URI.from({ scheme: 'aux-test', path: this._path })
  }
  getName(): string {
    return this._path
  }
  override serialize(): unknown {
    return { path: this._path }
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function makeLogger() {
  return {
    level: 0,
    onDidChangeLogLevel: Event.None,
    setLevel: vi.fn(),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn(),
    dispose: vi.fn(),
  }
}

interface FakeAux extends IAuxiliaryWindowsService {
  closeEmitter: Emitter<{ token: string }>
  prepareOpen: ReturnType<typeof vi.fn>
  cancelPrepared: ReturnType<typeof vi.fn>
  finalizeClose: ReturnType<typeof vi.fn>
  focusWindow: ReturnType<typeof vi.fn>
}

function makeAux(): FakeAux {
  let seq = 0
  const closeEmitter = new Emitter<{ token: string }>()
  return {
    _serviceBrand: undefined,
    onDidCreateWindow: Event.None,
    onDidCloseWindow: closeEmitter.event,
    onDidRequestClose: Event.None,
    onDidChangeWindowState: Event.None,
    closeEmitter,
    prepareOpen: vi.fn(async (): Promise<PreparedAuxiliaryWindow> => {
      const token = `token-${++seq}`
      return { token, frameName: token }
    }),
    cancelPrepared: vi.fn(async () => {}),
    getWindows: vi.fn(async () => []),
    getWindowState: vi.fn(async () => null),
    focusWindow: vi.fn(async () => {}),
    requestClose: vi.fn(async () => {}),
    finalizeClose: vi.fn(async () => {}),
    zoomIn: vi.fn(async () => {}),
    zoomOut: vi.fn(async () => {}),
    resetZoom: vi.fn(async () => {}),
    minimizeWindow: vi.fn(async () => {}),
    toggleMaximizeWindow: vi.fn(async () => {}),
  }
}

function fakeWindow(doc: Document, options: { marker?: boolean; closed?: boolean } = {}): Window {
  const win = {
    document: doc,
    closed: options.closed === true,
    close() {
      this.closed = true
    },
    addEventListener() {},
    removeEventListener() {},
    focus() {},
  }
  if (options.marker !== false) {
    ;(win as unknown as Record<string, unknown>)[AUXILIARY_WINDOW_MARKER_KEY] = { marker: true }
  }
  return win as unknown as Window
}

function setup() {
  const mainDoc = document.implementation.createHTMLDocument('main')
  const auxDoc = document.implementation.createHTMLDocument('aux')
  const groups = new EditorGroupsService()
  const windows = new WorkbenchWindowService()
  windows.registerMainWindow(groups.mainPart, mainDoc)
  const aux = makeAux()
  const windowFocus = new FakeWindowFocusService()
  const instantiation = new InstantiationService(new ServiceCollection())
  const notifications = {
    _serviceBrand: undefined,
    notify: vi.fn(),
  } as unknown as INotificationService
  const logger = makeLogger()
  const loggerService: ILoggerService = {
    _serviceBrand: undefined,
    createLogger: () => logger,
    setLevel: () => {},
    getLevel: () => 0,
  } as unknown as ILoggerService
  const service = new AuxiliaryEditorWindowService(
    groups as IEditorGroupsService,
    windows,
    aux,
    windowFocus,
    instantiation,
    notifications,
    loggerService,
  )
  const openSpy = vi.spyOn(window, 'open').mockImplementation(() => fakeWindow(auxDoc))
  return {
    mainDoc,
    auxDoc,
    groups,
    windows,
    aux,
    windowFocus,
    instantiation,
    service,
    openSpy,
    logger,
    notifications,
  }
}

describe('AuxiliaryEditorWindowService failure paths', () => {
  let ctx: ReturnType<typeof setup>

  beforeEach(() => {
    ctx = setup()
  })

  afterEach(() => {
    ctx.service.dispose()
    ctx.groups.dispose()
    ctx.windows.dispose()
    ctx.instantiation.dispose()
    ctx.openSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it('removes a window part it created when window.open is blocked', async () => {
    ctx.openSpy.mockReturnValueOnce(null)
    const result = await ctx.service.createEmptyWindow()
    expect(result.window).toBeUndefined()
    expect(ctx.groups.parts).toHaveLength(1)
    expect(ctx.aux.cancelPrepared).toHaveBeenCalled()
  })

  it('seeds an empty auxiliary title that is distinguishable from the main window', async () => {
    // 复制主工作区标题会让 Alt+Tab 出现两个完全相同的条目。
    const mainTitle = ctx.mainDoc.title
    const window = (await ctx.service.createEmptyWindow({ explicitEmpty: true })).window!
    expect(window).toBeDefined()
    expect(ctx.auxDoc.title).not.toBe(mainTitle)
    expect(ctx.auxDoc.title).toBe(localize('auxiliaryWindow.windowTitle', 'Editor Window'))
  })

  it('keeps an explicitly requested title', async () => {
    await ctx.service.createEmptyWindow({ explicitEmpty: true, title: 'Custom' })
    expect(ctx.auxDoc.title).toBe('Custom')
  })

  it('removes a window part it created when the preload marker is missing', async () => {
    ctx.openSpy.mockReturnValueOnce(
      fakeWindow(ctx.auxDoc, { marker: false, closed: true }) as unknown as Window,
    )
    const result = await ctx.service.createEmptyWindow()
    expect(result.window).toBeUndefined()
    expect(ctx.groups.parts).toHaveLength(1)
  })

  it('keeps a caller-provided part when the window fails after registration', async () => {
    const part = ctx.groups.createAuxiliaryPart({ activate: false })
    const input = new TestInput('/kept')
    part.activeGroup.openEditor(input)
    // Any post-registration failure must preserve a caller-provided part. Window
    // focus is fire-and-forget in the real service, so simulate the unlikely
    // synchronous throw (e.g. a disposed DI service) to exercise that path.
    const focusSpy = vi.spyOn(ctx.windowFocus, 'focusWindow').mockImplementationOnce(() => {
      throw new Error('focus failed')
    })

    const result = await ctx.service.createEmptyWindow({ part })
    expect(focusSpy).toHaveBeenCalledTimes(1)
    expect(result.window).toBeUndefined()
    // The restore path salvages this part's editors; it must not be destroyed
    // by the failure cleanup.
    expect(ctx.groups.parts).toContain(part)
    expect(part.activeGroup.contains(input)).toBe(true)
    expect(ctx.windows.windows).toHaveLength(1)
  })

  it('refuses to move an editor whose source disappeared while the window opened', async () => {
    const pending = deferred<PreparedAuxiliaryWindow>()
    ctx.aux.prepareOpen.mockReturnValueOnce(pending.promise)
    const source = ctx.groups.mainPart.activeGroup
    const input = new TestInput('/gone')
    source.openEditor(input)

    const move = ctx.service.moveEditorToNewWindow(input, source)
    source.closeEditor(input)
    pending.resolve({ token: 'late', frameName: 'late' })

    expect(await move).toBe(false)
    expect(ctx.service.windows).toHaveLength(0)
    expect(ctx.groups.parts).toHaveLength(1)
  })

  it('opens a new input directly in the auxiliary window and forwards placement hints', async () => {
    const input = new TestInput('/fresh')
    const result = await ctx.service.openEditorInNewWindow(input, {
      preferOtherDisplayFullscreen: true,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.editor).toBe(input)
    expect(result.window.part.activeGroup.contains(input)).toBe(true)
    expect(ctx.aux.prepareOpen).toHaveBeenCalledWith(
      expect.objectContaining({ preferOtherDisplayFullscreen: true }),
    )
    expect(ctx.service.windows).toHaveLength(1)
    // The window must survive: explicitEmpty was cleared once the editor landed.
    expect(result.window.explicitEmpty).toBe(false)
  })

  it('refuses open mode for an input that is still open in another group', async () => {
    const source = ctx.groups.mainPart.activeGroup
    const input = new TestInput('/already-open')
    source.openEditor(input)

    const result = await ctx.service.openEditorInNewWindow(input)
    expect(result).toEqual({ ok: false, reason: 'error' })
    expect(ctx.aux.prepareOpen).not.toHaveBeenCalled()
    expect(ctx.service.windows).toHaveLength(0)
    expect(source.contains(input)).toBe(true)
  })

  it('moves an already-open editor into the new window', async () => {
    const source = ctx.groups.mainPart.activeGroup
    const input = new TestInput('/move-me')
    source.openEditor(input)

    const result = await ctx.service.openEditorInNewWindow(input, {
      mode: 'move',
      source,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(source.contains(input)).toBe(false)
    expect(result.window.part.activeGroup.contains(input)).toBe(true)
    expect(result.editor).toBe(input)
  })

  it('copies an already-open editor, leaving the original tab alone', async () => {
    const registration = EditorRegistry.registerEditorProvider({
      typeId: TestInput.TYPE_ID,
      componentKey: TestInput.TYPE_ID,
      deserialize: (data) => new TestInput((data as { path: string }).path),
    })
    try {
      const source = ctx.groups.mainPart.activeGroup
      const input = new TestInput('/copy-me')
      source.openEditor(input)

      const result = await ctx.service.openEditorInNewWindow(input, {
        mode: 'copy',
        source,
        preferOtherDisplayFullscreen: true,
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(source.contains(input)).toBe(true)
      expect(result.editor).not.toBe(input)
      expect(result.window.part.activeGroup.contains(result.editor)).toBe(true)
      expect(result.editor.resource?.toString()).toBe(input.resource?.toString())
    } finally {
      registration.dispose()
    }
  })

  it('reports uncopyable inputs without creating a window', async () => {
    const source = ctx.groups.mainPart.activeGroup
    const input = new TestInput('/uncopyable')
    source.openEditor(input)
    // No EditorRegistry provider is registered for TestInput in this test.

    const result = await ctx.service.openEditorInNewWindow(input, {
      mode: 'copy',
      source,
    })
    expect(result).toEqual({ ok: false, reason: 'uncopyable' })
    expect(ctx.service.windows).toHaveLength(0)
    expect(source.contains(input)).toBe(true)
  })

  it('leaves a caller-owned open input intact when the window cannot be created', async () => {
    ctx.openSpy.mockReturnValueOnce(null)
    const input = new TestInput('/blocked')
    const result = await ctx.service.openEditorInNewWindow(input)
    expect(result).toEqual({ ok: false, reason: 'error' })
    expect(input.isDisposed).toBe(false)
    expect(ctx.groups.parts).toHaveLength(1)
  })

  it('keeps group metadata snapshotted before the window is created', async () => {
    const source = ctx.groups.mainPart.activeGroup
    const first = new TestInput('/first')
    const second = new TestInput('/second')
    source.openEditor(first, { activate: false })
    source.openEditor(second)
    source.stickEditor(first)
    source.lock(true)

    const pending = deferred<PreparedAuxiliaryWindow>()
    ctx.aux.prepareOpen.mockReturnValueOnce(pending.promise)
    const move = ctx.service.moveGroupToNewWindow(source)

    // Mutate the live group while the native window is being prepared.
    source.unstickEditor(first)
    source.lock(false)
    source.setActive(first)

    pending.resolve({ token: 'group', frameName: 'group' })
    expect(await move).toBe(true)

    const target = ctx.service.windows[0]!.part.activeGroup
    expect(target.isSticky(first)).toBe(true)
    expect(target.isLocked).toBe(true)
    expect(target.activeEditor).toBe(second)
  })

  it('does not close protected editors when the migration silently no-ops', async () => {
    const window = (await ctx.service.createEmptyWindow({ explicitEmpty: true })).window!
    const input = new TestInput('/dirty')
    input.setDirty(true)
    const source = window.part.activeGroup
    source.openEditor(input)

    const moveSpy = vi.spyOn(ctx.groups, 'moveEditor').mockImplementation(() => {})
    expect(await ctx.service.closeWindow(window)).toBe(false)
    expect(ctx.service.windows).toHaveLength(1)
    expect(source.contains(input)).toBe(true)
    expect(input.isDisposed).toBe(false)
    moveSpy.mockRestore()
  })

  it('salvages editors into a fresh group when the preferred migration throws', async () => {
    const window = (await ctx.service.createEmptyWindow({ explicitEmpty: true })).window!
    const input = new TestInput('/salvage')
    input.setDirty(true)
    window.part.activeGroup.openEditor(input)

    const moveSpy = vi.spyOn(ctx.groups, 'moveEditor')
    moveSpy.mockImplementationOnce(() => {
      throw new Error('same-id migrate conflict')
    })
    ctx.aux.closeEmitter.fire({ token: window.token })

    await expect.poll(() => ctx.groups.groups.some((group) => group.contains(input))).toBe(true)
    await expect.poll(() => ctx.service.windows.length).toBe(0)
    expect(input.isDisposed).toBe(false)
    expect(ctx.groups.parts).toHaveLength(1)
    // The retry used an independent main group rather than the conflicting target.
    expect(ctx.groups.mainPart.groups.some((group) => group.contains(input))).toBe(true)
  })

  it('requests native focus for a newly created window', async () => {
    const window = (await ctx.service.createEmptyWindow({ explicitEmpty: true })).window!

    expect(ctx.windowFocus.focusedWindows).toContain(window.window)
    // Creation must go through the cross-window service, never the raw IPC
    // channel — the service is the only place that dedupes DOM-focused windows.
    expect(ctx.aux.focusWindow).not.toHaveBeenCalled()
  })

  it('does not request native focus for activate:false windows (restore path)', async () => {
    const result = await ctx.service.createEmptyWindow({ explicitEmpty: true, activate: false })

    expect(result.window).toBeDefined()
    expect(ctx.windowFocus.focusedWindows).toHaveLength(0)
  })

  it('restore-all ends by requesting main-window focus', async () => {
    await ctx.service.createEmptyWindow({ explicitEmpty: true })

    ctx.service.restoreAllToMainWindow()

    expect(ctx.windowFocus.focusMainWindowCalls).toBe(1)
  })

  it('syncs the active part and window in both directions', async () => {
    const window = (await ctx.service.createEmptyWindow({ explicitEmpty: true, activate: false }))
      .window!
    ctx.windows.setActiveWindow(window.window)
    expect(ctx.groups.activePart).toBe(window.part)

    ctx.groups.activatePart(ctx.groups.mainPart)
    expect(ctx.windows.activeWindow).toBe(ctx.windows.mainWindow)
  })

  it('window activation moves focus but only auxiliary activation retargets opens', async () => {
    const window = (await ctx.service.createEmptyWindow({ explicitEmpty: true, activate: false }))
      .window!
    ctx.windows.setActiveWindow(window.window)
    expect(ctx.groups.activePart).toBe(window.part)
    expect(ctx.groups.openTargetPart).toBe(window.part)

    // Focusing the main sidebar (Ctrl+Shift+E → focusMainWindow) only moves the
    // active window; opens keep following the last-used editor surface.
    ctx.windows.setActiveWindow(ctx.windows.mainWindow)
    expect(ctx.windows.activeWindow).toBe(ctx.windows.mainWindow)
    expect(ctx.groups.activePart).toBe(ctx.groups.mainPart)
    expect(ctx.groups.openTargetPart).toBe(window.part)
  })

  it('falls back to the main part when the active part loses its window but survives', async () => {
    const window = (await ctx.service.createEmptyWindow({ explicitEmpty: true })).window!
    expect(ctx.groups.activePart).toBe(window.part)

    // Salvage-close keeps a part with editors alive after its window is gone;
    // opens must not keep targeting that invisible part.
    ctx.windows.unregisterWindow(window.window)
    expect(ctx.groups.activePart).toBe(ctx.groups.mainPart)
    expect(ctx.groups.openTargetPart).toBe(ctx.groups.mainPart)
  })

  it('keeps the focused part when only the open-target window disappears', async () => {
    const focused = (await ctx.service.createEmptyWindow({ explicitEmpty: true })).window!
    const target = (await ctx.service.createEmptyWindow({ explicitEmpty: true, activate: false }))
      .window!
    ctx.windows.setActiveWindow(focused.window)
    // Tab activation in another window retargets opens without moving focus.
    ctx.groups.activateGroup(target.part.activeGroup)
    expect(ctx.groups.activePart).toBe(focused.part)
    expect(ctx.groups.openTargetPart).toBe(target.part)

    const announced: unknown[] = []
    ctx.groups.onDidActivateOpenTargetGroup((group) => announced.push(group))

    ctx.windows.unregisterWindow(target.window)

    expect(ctx.groups.activePart).toBe(focused.part)
    expect(ctx.groups.openTargetPart).toBe(focused.part)
    // A fallback must not announce: that would bring a background window front.
    expect(announced).toHaveLength(0)
  })

  it('restore-all keeps the main window multi-group layout intact', async () => {
    const first = ctx.groups.mainPart.activeGroup
    const kept = new TestInput('/kept-in-main')
    first.openEditor(kept)
    const second = ctx.groups.addGroup(first, GroupDirection.Right)
    ctx.groups.activateGroup(second)

    const window = (await ctx.service.createEmptyWindow({ explicitEmpty: true })).window!
    const moved = new TestInput('/from-aux')
    window.part.activeGroup.openEditor(moved)

    ctx.service.restoreAllToMainWindow()

    expect(ctx.service.windows).toHaveLength(0)
    expect(ctx.groups.mainPart.groups).toEqual([first, second])
    expect(first.contains(kept)).toBe(true)
    expect(second.contains(moved)).toBe(true)
    // The normal path leaves no orphan part/window or failure notification.
    expect(ctx.groups.parts).toHaveLength(1)
    expect(ctx.service.serialize().windows).toHaveLength(0)
    expect(ctx.notifications.notify).not.toHaveBeenCalled()
  })

  it('serializes a part kept after both salvage moves fail and rescues it once the fault clears', async () => {
    const window = (await ctx.service.createEmptyWindow({ explicitEmpty: true })).window!
    const input = new TestInput('/orphan')
    window.part.activeGroup.openEditor(input)

    // Both the preferred target and the fresh fallback group reject the move.
    const moveSpy = vi.spyOn(ctx.groups, 'moveEditor').mockImplementation(() => {
      throw new Error('move unavailable')
    })
    ctx.aux.closeEmitter.fire({ token: window.token })
    await expect.poll(() => ctx.service.windows.length).toBe(0)

    expect(input.isDisposed).toBe(false)
    expect(ctx.groups.groups.some((group) => group.contains(input))).toBe(true)
    // The user gets a recovery affordance instead of only a log line.
    expect(ctx.notifications.notify).toHaveBeenCalled()
    const serialized = ctx.service.serialize()
    expect(serialized.windows).toHaveLength(1)
    expect(JSON.stringify(serialized)).toContain('/orphan')

    moveSpy.mockRestore()
    ctx.service.restoreAllToMainWindow()

    expect(ctx.groups.mainPart.groups.some((group) => group.contains(input))).toBe(true)
    expect(ctx.groups.parts).toHaveLength(1)
    expect(ctx.service.serialize().windows).toHaveLength(0)
  })

  it('does not register a window when its part is cleared while prepareOpen is pending', async () => {
    const pending = deferred<PreparedAuxiliaryWindow>()
    ctx.aux.prepareOpen.mockReturnValueOnce(pending.promise)

    const created = ctx.service.createEmptyWindow()
    // Workspace scope swap: auxiliary parts are destroyed underneath us.
    ctx.groups.clearAll()
    pending.resolve({ token: 'stale', frameName: 'stale' })

    const result = await created
    expect(result.window).toBeUndefined()
    expect(ctx.service.windows).toHaveLength(0)
    expect(ctx.groups.parts).toHaveLength(1)
    expect(ctx.windows.windows).toHaveLength(1)
    expect(ctx.openSpy).not.toHaveBeenCalled()
    expect(ctx.aux.cancelPrepared).toHaveBeenCalled()
  })

  it('does not register a window for a caller-provided part cleared while prepareOpen is pending', async () => {
    const part = ctx.groups.createAuxiliaryPart({ activate: false })
    part.activeGroup.openEditor(new TestInput('/stale-provided'))
    const pending = deferred<PreparedAuxiliaryWindow>()
    ctx.aux.prepareOpen.mockReturnValueOnce(pending.promise)

    const created = ctx.service.createEmptyWindow({ part, activate: false })
    ctx.groups.clearAll()
    pending.resolve({ token: 'stale-provided', frameName: 'stale-provided' })

    const result = await created
    expect(result.window).toBeUndefined()
    expect(ctx.service.windows).toHaveLength(0)
    expect(ctx.groups.parts).toHaveLength(1)
    expect(ctx.windows.windows).toHaveLength(1)
    expect(ctx.openSpy).not.toHaveBeenCalled()
    expect(ctx.aux.cancelPrepared).toHaveBeenCalled()
  })

  it('releases the main document registration when disposed', () => {
    expect(getWorkbenchDocuments()).toContain(ctx.mainDoc)
    ctx.windows.dispose()
    expect(getWorkbenchDocuments()).not.toContain(ctx.mainDoc)
    // afterEach disposes again; Disposable is idempotent.
  })

  it('creates the fallback group only when a move fails', async () => {
    const before = ctx.groups.mainPart.groups.length
    const window = (await ctx.service.createEmptyWindow({ explicitEmpty: true })).window!
    const input = new TestInput('/plain')
    window.part.activeGroup.openEditor(input)
    ctx.aux.closeEmitter.fire({ token: window.token })
    await expect.poll(() => ctx.service.windows.length).toBe(0)
    expect(ctx.groups.mainPart.groups.length).toBe(before)
  })

  describe('move back to the main window', () => {
    async function moveToAuxWindow(input: TestInput): Promise<IAuxiliaryEditorWindow> {
      const source = ctx.groups.mainPart.activeGroup
      source.openEditor(input)
      const result = await ctx.service.openEditorInNewWindow(input, { mode: 'move', source })
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error('auxiliary window creation failed')
      return result.window
    }

    it('moves one editor into the main window and brings it forward', async () => {
      const input = new TestInput('/move-back')
      const window = await moveToAuxWindow(input)
      const source = window.part.activeGroup
      expect(ctx.groups.activePart).toBe(window.part)

      expect(ctx.service.moveEditorToMainWindow(input, source)).toBe(true)

      const target = ctx.groups.mainPart.activeGroup
      expect(target.contains(input)).toBe(true)
      expect(source.contains(input)).toBe(false)
      expect(input.isDisposed).toBe(false)
      expect(ctx.groups.activePart).toBe(ctx.groups.mainPart)
      expect(ctx.windows.activeWindow).toBe(ctx.windows.mainWindow)
      expect(ctx.windowFocus.focusMainWindowCalls).toBe(1)
    })

    it('closes the auxiliary window after its last editor leaves', async () => {
      const input = new TestInput('/last-editor')
      const window = await moveToAuxWindow(input)

      expect(ctx.service.moveEditorToMainWindow(input, window.part.activeGroup)).toBe(true)
      await Promise.resolve()
      expect(ctx.aux.requestClose).toHaveBeenCalledWith(window.token)
    })

    it('keeps a non-empty auxiliary window open while the main window comes forward', async () => {
      const first = new TestInput('/first-tab')
      const window = await moveToAuxWindow(first)
      const second = new TestInput('/second-tab')
      window.part.activeGroup.openEditor(second)

      expect(ctx.service.moveEditorToMainWindow(first, window.part.activeGroup)).toBe(true)
      await Promise.resolve()

      expect(ctx.service.windows).toHaveLength(1)
      expect(window.part.activeGroup.contains(second)).toBe(true)
      expect(ctx.aux.requestClose).not.toHaveBeenCalled()
      expect(ctx.windows.activeWindow).toBe(ctx.windows.mainWindow)
    })

    it('skips a locked main group and lands in the most recent unlocked one', async () => {
      const locked = ctx.groups.mainPart.activeGroup
      const unlocked = ctx.groups.addGroup(locked, GroupDirection.Right)
      locked.lock(true)
      const input = new TestInput('/unlock-target')
      const window = await moveToAuxWindow(input)

      expect(ctx.service.moveEditorToMainWindow(input, window.part.activeGroup)).toBe(true)
      expect(locked.contains(input)).toBe(false)
      expect(unlocked.contains(input)).toBe(true)
      expect(ctx.groups.mainPart.activeGroup).toBe(unlocked)
    })

    it('rejects main-window sources, stale sources and disposed editors without focus side effects', async () => {
      const main = ctx.groups.mainPart.activeGroup
      const inMain = new TestInput('/in-main')
      main.openEditor(inMain)
      expect(ctx.service.moveEditorToMainWindow(inMain, main)).toBe(false)

      const input = new TestInput('/stale')
      const window = await moveToAuxWindow(input)
      const other = ctx.groups.mainPart.activeGroup
      expect(ctx.service.moveEditorToMainWindow(input, other)).toBe(false)

      input.dispose()
      expect(ctx.service.moveEditorToMainWindow(input, window.part.activeGroup)).toBe(false)
      expect(ctx.windowFocus.focusMainWindowCalls).toBe(0)
    })

    it('reports a silently rejected move without touching focus', async () => {
      const input = new TestInput('/silent-noop')
      const window = await moveToAuxWindow(input)
      const source = window.part.activeGroup
      const moveSpy = vi.spyOn(ctx.groups, 'moveEditor').mockImplementation(() => {})

      expect(ctx.service.moveEditorToMainWindow(input, source)).toBe(false)
      expect(source.contains(input)).toBe(true)
      expect(ctx.windowFocus.focusMainWindowCalls).toBe(0)
      expect(ctx.groups.activePart).toBe(window.part)

      moveSpy.mockRestore()
    })

    it('moves a whole group preserving order, sticky and active editor', async () => {
      const first = new TestInput('/group-first')
      const window = await moveToAuxWindow(first)
      const second = new TestInput('/group-second')
      const source = window.part.activeGroup
      source.openEditor(second)
      source.stickEditor(first)
      source.setActive(first)

      expect(ctx.service.moveGroupToMainWindow(source)).toBe(true)

      const target = ctx.groups.mainPart.activeGroup
      expect(target.editors.filter((editor) => editor === first || editor === second)).toEqual([
        first,
        second,
      ])
      expect(target.isSticky(first)).toBe(true)
      expect(target.activeEditor).toBe(first)
      expect(source.count).toBe(0)
      expect(ctx.windowFocus.focusMainWindowCalls).toBe(1)
      await Promise.resolve()
      expect(ctx.aux.requestClose).toHaveBeenCalledWith(window.token)
    })

    it('drops an emptied split while another auxiliary group keeps the window open', async () => {
      const first = new TestInput('/split-first')
      const window = await moveToAuxWindow(first)
      const source = window.part.activeGroup
      const other = ctx.groups.addGroup(source, GroupDirection.Right)
      const kept = new TestInput('/split-kept')
      other.openEditor(kept)

      expect(ctx.service.moveGroupToMainWindow(source)).toBe(true)
      await Promise.resolve()

      expect(window.part.groups).toEqual([other])
      expect(ctx.service.windows).toHaveLength(1)
      expect(ctx.aux.requestClose).not.toHaveBeenCalled()
      expect(ctx.groups.mainPart.activeGroup.contains(first)).toBe(true)
    })

    it('keeps unmoved editors in the source group when a group move fails midway', async () => {
      const first = new TestInput('/partial-first')
      const window = await moveToAuxWindow(first)
      const second = new TestInput('/partial-second')
      const source = window.part.activeGroup
      source.openEditor(second)

      const original = ctx.groups.moveEditor.bind(ctx.groups)
      let calls = 0
      const moveSpy = vi
        .spyOn(ctx.groups, 'moveEditor')
        .mockImplementation((editor, target, src) => {
          calls++
          if (calls === 2) throw new Error('rejected')
          original(editor, target, src)
        })

      expect(ctx.service.moveGroupToMainWindow(source)).toBe(false)
      expect(first.isDisposed).toBe(false)
      expect(second.isDisposed).toBe(false)
      expect(ctx.groups.mainPart.activeGroup.contains(first)).toBe(true)
      expect(source.contains(second)).toBe(true)
      expect(ctx.windowFocus.focusMainWindowCalls).toBe(0)

      moveSpy.mockRestore()
    })

    it('ignores main-window and empty groups', async () => {
      const main = ctx.groups.mainPart.activeGroup
      expect(ctx.service.moveGroupToMainWindow(main)).toBe(false)

      const window = (await ctx.service.createEmptyWindow({ explicitEmpty: true })).window!
      expect(ctx.service.moveGroupToMainWindow(window.part.activeGroup)).toBe(false)
      expect(ctx.windowFocus.focusMainWindowCalls).toBe(0)
    })
  })
})
