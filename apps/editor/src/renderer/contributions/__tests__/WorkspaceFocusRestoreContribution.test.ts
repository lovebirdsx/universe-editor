import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ContextKeyService,
  Emitter,
  PartId,
  observableValue,
  type IEditorGroupsService,
  type IFocusChangeEvent,
  type IFocusTrackerService,
  type ILayoutService,
  type ILogger,
  type ILoggerService,
  type IViewsService,
  type IWorkspace,
  type IWorkspaceService,
} from '@universe-editor/platform'
import { WorkspaceFocusRestoreContribution } from '../WorkspaceFocusRestoreContribution.js'
import type { ITerminalManagerService } from '../../services/terminal/TerminalManagerService.js'
import { EXPLORER_TREE_VIEW_ID } from '../../services/focus/workbenchFocusRestorer.js'

function makeContext() {
  const workspaceEmitter = new Emitter<IWorkspace | null>()
  const focusEmitter = new Emitter<IFocusChangeEvent>()
  const focusView = vi.fn(async () => true)
  const workspace = {
    _serviceBrand: undefined,
    current: null,
    recent: [],
    onDidChangeWorkspace: workspaceEmitter.event,
    onDidChangeRecent: new Emitter<readonly never[]>().event,
    openFolder: vi.fn(async () => {}),
    closeFolder: vi.fn(async () => {}),
    clearRecent: vi.fn(async () => {}),
  } as unknown as IWorkspaceService
  const activeGroup = {
    id: 1,
    activeEditor: undefined,
    onDidChangeModel: new Emitter<never>().event,
    onDidActiveEditorChange: new Emitter<never>().event,
  }
  const groups = {
    _serviceBrand: undefined,
    groups: [activeGroup],
    activeGroup,
    onDidAddGroup: new Emitter<never>().event,
    onDidRemoveGroup: new Emitter<never>().event,
    onDidActiveGroupChange: new Emitter<never>().event,
    onDidMoveGroup: new Emitter<never>().event,
  } as unknown as IEditorGroupsService
  const layout = {
    _serviceBrand: undefined,
    visible: observableValue('test.visible', {
      [PartId.ActivityBar]: true,
      [PartId.SideBar]: true,
      [PartId.SecondarySideBar]: false,
      [PartId.EditorArea]: true,
      [PartId.Panel]: false,
      [PartId.StatusBar]: true,
    }),
    focusView,
  } as unknown as ILayoutService
  const views = {
    _serviceBrand: undefined,
    getActiveViewContainerId: () => undefined,
  } as unknown as IViewsService
  const terminals = {
    _serviceBrand: undefined,
    panelTerminals: observableValue<readonly never[]>('test.panelTerminals', []),
    activeTerminalId: observableValue<string | undefined>('test.activeTerminalId', undefined),
    activeGroupId: observableValue<string | undefined>('test.activeGroupId', undefined),
  } as unknown as ITerminalManagerService
  const focusTracker = {
    _serviceBrand: undefined,
    current: null,
    onDidFocusChange: focusEmitter.event,
    trackElement: () => ({ dispose() {} }),
  } as unknown as IFocusTrackerService
  const debug = vi.fn()
  const logger = {
    level: 0,
    onDidChangeLogLevel: new Emitter<never>().event,
    setLevel: () => {},
    trace: vi.fn(),
    debug,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: () => {},
    dispose: () => {},
  } as unknown as ILogger
  const loggerService = {
    _serviceBrand: undefined,
    createLogger: () => logger,
  } as unknown as ILoggerService

  const contribution = new WorkspaceFocusRestoreContribution(
    workspace,
    groups,
    layout,
    views,
    new ContextKeyService(),
    terminals,
    loggerService,
    focusTracker,
  )
  return {
    contribution,
    focusView,
    debug,
    focusIn: (target: Element) => focusEmitter.fire({ current: target as never, previous: null }),
    changeWorkspace: () => workspaceEmitter.fire(null),
  }
}

/** A focusable element inside the part with the given `data-testid`. */
function elementInPart(testId: string): HTMLElement {
  const part = document.createElement('div')
  part.setAttribute('data-testid', testId)
  const target = document.createElement('div')
  target.tabIndex = 0
  part.appendChild(target)
  document.body.appendChild(part)
  return target
}

describe('WorkspaceFocusRestoreContribution', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('restores focus after a workspace switch when the user did not move focus', async () => {
    const ctx = makeContext()
    ctx.changeWorkspace()
    await vi.advanceTimersByTimeAsync(100)

    expect(ctx.focusView).toHaveBeenCalledWith(EXPLORER_TREE_VIEW_ID, { source: 'restore' })
    ctx.contribution.dispose()
  })

  it('cancels the restore once the user moves focus into another part', async () => {
    const ctx = makeContext()
    ctx.changeWorkspace()
    // E.g. the user clicks the Search view within the restore window.
    ctx.focusIn(elementInPart('part-sidebar'))
    await vi.advanceTimersByTimeAsync(100)

    expect(ctx.focusView).not.toHaveBeenCalled()
    ctx.contribution.dispose()
  })

  it('cancels the restore when focus moves to an overlay outside every part', async () => {
    const ctx = makeContext()
    ctx.changeWorkspace()
    // Quick input / modal dialogs render outside the Part tree.
    const overlay = document.createElement('input')
    document.body.appendChild(overlay)
    ctx.focusIn(overlay)
    await vi.advanceTimersByTimeAsync(100)

    expect(ctx.focusView).not.toHaveBeenCalled()
    expect(ctx.debug).toHaveBeenCalledWith(expect.stringContaining('an overlay'))
    ctx.contribution.dispose()
  })

  it('cancels a pending restore on dispose', async () => {
    const ctx = makeContext()
    ctx.changeWorkspace()
    ctx.contribution.dispose()
    await vi.advanceTimersByTimeAsync(100)

    expect(ctx.focusView).not.toHaveBeenCalled()
  })

  it('keeps restoring when focus stays inside the editor area', async () => {
    const ctx = makeContext()
    ctx.changeWorkspace()
    ctx.focusIn(elementInPart('part-editorArea'))
    await vi.advanceTimersByTimeAsync(100)

    expect(ctx.focusView).toHaveBeenCalledWith(EXPLORER_TREE_VIEW_ID, { source: 'restore' })
    ctx.contribution.dispose()
  })

  it('ignores focus moves that happen outside the restore window', async () => {
    const ctx = makeContext()
    ctx.changeWorkspace()
    await vi.advanceTimersByTimeAsync(2000)
    ctx.debug.mockClear()
    ctx.focusIn(elementInPart('part-sidebar'))

    const calls = ctx.focusView.mock.calls.length
    await vi.advanceTimersByTimeAsync(200)

    expect(ctx.focusView.mock.calls.length).toBe(calls)
    // The window already expired; a later focus move must not be logged as a
    // cancellation (the sentinel used to be a bare 0 check).
    expect(ctx.debug).not.toHaveBeenCalled()
    ctx.contribution.dispose()
  })
})
