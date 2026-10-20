/*---------------------------------------------------------------------------------------------
 *  Failure-path tests for the auxiliary window service: creation cleanup,
 *  move/copy revalidation, close veto and salvage ownership.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EditorInput,
  Emitter,
  Event,
  GroupDirection,
  InstantiationService,
  ServiceCollection,
  URI,
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
    ctx.aux.focusWindow.mockRejectedValueOnce(new Error('focus failed'))

    const result = await ctx.service.createEmptyWindow({ part, activate: false })
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

  it('syncs the active part and window in both directions', async () => {
    const window = (await ctx.service.createEmptyWindow({ explicitEmpty: true, activate: false }))
      .window!
    ctx.windows.setActiveWindow(window.window)
    expect(ctx.groups.activePart).toBe(window.part)

    ctx.groups.activatePart(ctx.groups.mainPart)
    expect(ctx.windows.activeWindow).toBe(ctx.windows.mainWindow)
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
})
