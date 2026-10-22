/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Worktree badges in the Git Graph editor: a linked worktree is drawn on the
 *  commit its HEAD points at, the currently-open one is marked, and right-clicking
 *  a badge opens a menu whose items depend on whether it is the current / main tree.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import {
  CommandsRegistry,
  ContextKeyService,
  ICommandService,
  IDialogService,
  INotificationService,
  IProgressService,
  IQuickInputService,
  IStorageService,
  IViewDescriptorService,
  IViewsService,
  InstantiationService,
  ProgressLocation,
  Severity,
  ServiceCollection,
  observableValue,
  type IDisposable,
  type IProgressOptions,
  type IQuickPickItem,
} from '@universe-editor/platform'
import {
  GitGraphCommands,
  type GitGraphLoadResult,
  type GitGraphWorktreeDto,
  type GitGraphWorktreeSyncResult,
} from '@universe-editor/extensions-common'
import { IScmService } from '../../../services/extensions/ScmService.js'
import { QuickInputService } from '../../../services/quickInput/QuickInputService.js'
import {
  FakeQuickInputService,
  type FakeQuickPick,
} from '../../../services/quickInput/__tests__/fakeQuickPick.js'
import { ServicesContext } from '../../useService.js'
import { QuickInputPortal } from '../../quickinput/QuickInput.js'
import { scmViewState } from '../../scm/scmViewState.js'
import { gitGraphViewState } from '../../../services/gitGraph/gitGraphViewState.js'
import { GitGraphEditor } from '../GitGraphEditor.js'

const HASH = '1111111111111111111111111111111111111111'

const mainWt: GitGraphWorktreeDto = {
  path: '/repo',
  name: 'repo',
  branch: 'main',
  isCurrent: true,
  isMain: true,
}
const featureWt: GitGraphWorktreeDto = {
  path: '/repo.worktrees/feature',
  name: 'feature',
  branch: 'feature',
  isCurrent: false,
  isMain: false,
}

function makeResult(worktrees: GitGraphWorktreeDto[]): GitGraphLoadResult {
  return {
    commits: [
      {
        hash: HASH,
        parents: [],
        author: 'tester',
        email: 't@example.com',
        date: 1,
        message: 'first',
        heads: [],
        tags: [],
        remotes: [],
        stash: null,
        worktrees,
      },
    ],
    head: HASH,
    headName: 'main',
    moreAvailable: false,
    uncommittedChanges: 0,
  }
}

interface CommandStubs {
  syncResult?: GitGraphWorktreeSyncResult | undefined
  pushResult?: boolean | undefined
  syncError?: unknown
  pushError?: unknown
}

function makeCommandService(stubs: CommandStubs = {}): {
  service: ICommandService
  executeCommand: ReturnType<typeof vi.fn>
} {
  const executeCommand = vi.fn(async (id: string) => {
    switch (id) {
      case GitGraphCommands.getCommits:
        return gitGraphViewState.result
      case GitGraphCommands.getRepos:
        return []
      case GitGraphCommands.syncWorktrees:
        if (stubs.syncError !== undefined) throw stubs.syncError
        return stubs.syncResult
      case GitGraphCommands.pushBranch:
        if (stubs.pushError !== undefined) throw stubs.pushError
        return stubs.pushResult
      default:
        return undefined
    }
  })
  const service = {
    _serviceBrand: undefined,
    executeCommand,
    onWillExecuteCommand: () => ({ dispose: () => {} }),
    onDidExecuteCommand: () => ({ dispose: () => {} }),
  } as unknown as ICommandService
  return { service, executeCommand }
}

function makeScmService(): IScmService {
  return {
    _serviceBrand: undefined,
    sourceControls: observableValue('test.sourceControls', []),
    changeInputBoxValue: vi.fn(),
    setExtHost: vi.fn(),
    resetSourceControls: vi.fn(),
  } as unknown as IScmService
}

function makeDialog(confirmed: boolean): IDialogService {
  return {
    _serviceBrand: undefined,
    confirm: vi.fn().mockResolvedValue({ confirmed }),
    prompt: vi.fn().mockResolvedValue(undefined),
  } as unknown as IDialogService
}

function makeNotificationService(): {
  service: INotificationService
  notify: ReturnType<typeof vi.fn>
} {
  const notify = vi.fn(() => ({ dispose: () => {} }))
  return {
    service: { _serviceBrand: undefined, notify } as unknown as INotificationService,
    notify,
  }
}

type NotifyOptions = Parameters<INotificationService['notify']>[0]

function lastNotification(notify: ReturnType<typeof vi.fn>): NotifyOptions | undefined {
  return notify.mock.calls.at(-1)?.[0] as NotifyOptions | undefined
}

/**
 * `quickInput`: 'fake' records what the editor asked of the picker, 'real' mounts
 * the actual QuickInputPanel (so the focus/keyboard contract is exercised end to
 * end), 'none' leaves IQuickInputService unregistered (the editor resolves it
 * optionally).
 */
function renderEditor(
  confirmed = true,
  opts: { quickInput?: 'fake' | 'real' | 'none'; commands?: CommandStubs } = {},
) {
  const quickInputMode = opts.quickInput ?? 'fake'
  const { service: commandService, executeCommand } = makeCommandService(opts.commands)
  // Runs the task straight through while recording the options — lets tests
  // assert the sync is wrapped in a progress notification.
  const withProgress = vi.fn(async (_options: IProgressOptions, task: () => Promise<unknown>) =>
    task(),
  )
  const services = new ServiceCollection()
  services.set(ICommandService, commandService)
  services.set(IScmService, makeScmService())
  const dialog = makeDialog(confirmed)
  services.set(IDialogService, dialog)
  const notification = makeNotificationService()
  services.set(INotificationService, notification.service)
  services.set(IProgressService, {
    _serviceBrand: undefined,
    withProgress,
  } as unknown as IProgressService)
  const storageStub = {
    _serviceBrand: undefined,
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    onDidChangeWorkspaceScope: () => ({ dispose: () => {} }),
  } as unknown as IStorageService
  services.set(IStorageService, storageStub)
  services.set(IViewsService, {
    _serviceBrand: undefined,
    openViewContainer: vi.fn(),
  } as unknown as IViewsService)
  services.set(IViewDescriptorService, {
    _serviceBrand: undefined,
    setViewCollapsed: vi.fn(),
  } as unknown as IViewDescriptorService)
  const quickInput = new FakeQuickInputService()
  if (quickInputMode === 'fake') services.set(IQuickInputService, quickInput)
  if (quickInputMode === 'real') {
    services.set(IQuickInputService, new QuickInputService(storageStub, new ContextKeyService()))
  }
  const instantiation = new InstantiationService(services)
  const utils = render(
    <ServicesContext.Provider value={instantiation}>
      <GitGraphEditor input={{} as never} />
      {quickInputMode === 'real' && <QuickInputPortal />}
    </ServicesContext.Provider>,
  )
  return {
    executeCommand,
    withProgress,
    quickInput,
    dialog,
    notify: notification.notify,
    ...utils,
  }
}

async function flush(): Promise<void> {
  // Several macro rounds: the storage-read → restore-decision →
  // default-selection → payload-fetch chain schedules one React render per step, and each
  // render is flushed on its own macrotask.
  for (let round = 0; round < 10; round++) {
    for (let i = 0; i < 8; i++) await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    for (let i = 0; i < 8; i++) await Promise.resolve()
  }
}

// The editor gates its initial queries on the git-graph commands being
// registered (they arrive asynchronously from the extension host at runtime).
let graphCommandStub: IDisposable
beforeEach(() => {
  graphCommandStub = CommandsRegistry.registerCommand(GitGraphCommands.getCommits, () => undefined)
  // happy-dom has no layout engine, so every element measures 0 and the quick
  // pick's virtualizer would window down to zero rows — the real-panel assertions
  // below would then pass on an empty list for the wrong reason.
  // @tanstack/react-virtual sizes its scroller from clientWidth/Height (not
  // offset or getBoundingClientRect), so those are what have to answer.
  for (const prop of ['clientHeight', 'clientWidth'] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => 400 })
  }
})

afterEach(() => {
  graphCommandStub.dispose()
  for (const prop of ['clientHeight', 'clientWidth'] as const) {
    Reflect.deleteProperty(HTMLElement.prototype, prop)
  }
  gitGraphViewState.result = null
  gitGraphViewState.selection = []
  gitGraphViewState.repos = []
  gitGraphViewState.selectedRepo = null
  scmViewState.setSelectedRepo(undefined)
  vi.clearAllMocks()
})

describe('GitGraphEditor worktree badges', () => {
  it('renders a badge per worktree, marking the current one', async () => {
    gitGraphViewState.result = makeResult([mainWt, featureWt])
    renderEditor()
    await flush()

    expect(screen.getByText('✓ repo')).toBeTruthy()
    expect(screen.getByText('feature')).toBeTruthy()
  })

  it('current worktree menu offers new-window + copy but no open/delete', async () => {
    gitGraphViewState.result = makeResult([mainWt])
    renderEditor()
    await flush()

    fireEvent.contextMenu(screen.getByText('✓ repo'))
    const menu = screen.getByRole('menu')
    const labels = within(menu)
      .getAllByRole('menuitem')
      .map((el) => el.textContent)
    expect(labels).toContain('Open worktree in new window')
    expect(labels).toContain('Copy worktree path')
    expect(labels).not.toContain('Open worktree')
    expect(labels).not.toContain('Delete worktree…')
  })

  it('non-current worktree menu can open and delete, invoking the right commands', async () => {
    gitGraphViewState.result = makeResult([featureWt])
    const { executeCommand } = renderEditor(true)
    await flush()

    fireEvent.contextMenu(screen.getByText('feature'))
    const menu = screen.getByRole('menu')

    fireEvent.click(within(menu).getByText('Open worktree'))
    expect(executeCommand).toHaveBeenCalledWith(
      GitGraphCommands.openWorktree,
      featureWt.path,
      false,
    )

    fireEvent.contextMenu(screen.getByText('feature'))
    fireEvent.click(within(screen.getByRole('menu')).getByText('Delete worktree…'))
    await flush()
    expect(executeCommand).toHaveBeenCalledWith(GitGraphCommands.deleteWorktree, featureWt.path)
  })

  it('does not delete when the confirm dialog is dismissed', async () => {
    gitGraphViewState.result = makeResult([featureWt])
    const { executeCommand } = renderEditor(false)
    await flush()

    fireEvent.contextMenu(screen.getByText('feature'))
    fireEvent.click(within(screen.getByRole('menu')).getByText('Delete worktree…'))
    await flush()
    expect(executeCommand).not.toHaveBeenCalledWith(GitGraphCommands.deleteWorktree, featureWt.path)
  })
})

describe('GitGraphEditor worktree sync', () => {
  const detachedWt: GitGraphWorktreeDto = {
    path: '/repo.worktrees/wip',
    name: 'wip',
    branch: null,
    isCurrent: false,
    isMain: false,
  }
  // Fed to the graph out of alphabetical order on purpose: the picker owns the
  // ordering, not the payload.
  const zebraWt: GitGraphWorktreeDto = {
    path: '/repo.worktrees/zebra',
    name: 'zebra',
    branch: 'br/zebra',
    isCurrent: false,
    isMain: false,
  }
  const appleWt: GitGraphWorktreeDto = {
    path: '/repo.worktrees/apple',
    name: 'apple',
    branch: 'br/apple',
    isCurrent: false,
    isMain: false,
  }

  /** The sync command's calls. `not.toHaveBeenCalledWith` cannot express "never
   *  ran": it also matches on arity, and the real call passes four arguments. */
  function syncCalls(executeCommand: ReturnType<typeof vi.fn>): unknown[][] {
    return executeCommand.mock.calls.filter((call) => call[0] === GitGraphCommands.syncWorktrees)
  }

  /** Run a sync entry off the main worktree's badge menu and hand back the picker. */
  function openSyncPicker(
    quickInput: FakeQuickInputService,
    label = 'Sync worktrees to main…',
  ): FakeQuickPick<IQuickPickItem> {
    fireEvent.contextMenu(screen.getByText('✓ repo'))
    fireEvent.click(within(screen.getByRole('menu')).getByText(label))
    const picker = quickInput.picker
    if (!picker) throw new Error('the editor did not open a quick pick')
    return picker
  }

  it('offers the sync item when the target has a branch and others exist', async () => {
    gitGraphViewState.result = makeResult([mainWt, featureWt])
    renderEditor()
    await flush()

    fireEvent.contextMenu(screen.getByText('✓ repo'))
    const labels = within(screen.getByRole('menu'))
      .getAllByRole('menuitem')
      .map((el) => el.textContent)
    expect(labels).toContain('Sync worktrees to main…')
    expect(labels).toContain('Force sync worktrees to main…')
  })

  it('hides the sync item for a detached target', async () => {
    gitGraphViewState.result = makeResult([mainWt, detachedWt])
    renderEditor()
    await flush()

    fireEvent.contextMenu(screen.getByText('wip'))
    const labels = within(screen.getByRole('menu'))
      .getAllByRole('menuitem')
      .map((el) => el.textContent)
    expect(labels.some((l) => l?.startsWith('Sync worktrees'))).toBe(false)
  })

  it('hides the sync item when no other worktree exists', async () => {
    gitGraphViewState.result = makeResult([mainWt])
    renderEditor()
    await flush()

    fireEvent.contextMenu(screen.getByText('✓ repo'))
    const labels = within(screen.getByRole('menu'))
      .getAllByRole('menuitem')
      .map((el) => el.textContent)
    expect(labels.some((l) => l?.startsWith('Sync worktrees'))).toBe(false)
  })

  it('opens an all-checked multi-select picker over the other worktrees', async () => {
    gitGraphViewState.result = makeResult([mainWt, zebraWt, appleWt])
    const { quickInput } = renderEditor()
    await flush()

    const picker = openSyncPicker(quickInput)

    // Every other worktree, alphabetically, checked up front; the branch is the
    // description so it can be matched and read at a glance.
    expect(picker.canSelectMany).toBe(true)
    expect(picker.rows.map((it) => it.label)).toEqual(['apple', 'zebra'])
    expect(picker.selectedItems).toEqual(picker.rows)
    expect(picker.rows[0]?.description).toBe('br/apple')
    expect(picker.matchOnDescription).toBe(true)
    expect(picker.filterMode).toBe('fuzzyKeepOrder')
    expect(picker.title).toContain('main')
    expect(picker.okLabel).toBe('Sync (2)')
  })

  it('syncs the picked worktrees to the target branch on confirm', async () => {
    gitGraphViewState.result = makeResult([mainWt, featureWt])
    const { executeCommand, quickInput } = renderEditor()
    await flush()

    openSyncPicker(quickInput).triggerOk()
    await flush()

    expect(executeCommand).toHaveBeenCalledWith(
      GitGraphCommands.syncWorktrees,
      'main',
      [{ path: featureWt.path, name: featureWt.name }],
      false,
    )
  })

  it('shows a progress notification while the sync command runs', async () => {
    gitGraphViewState.result = makeResult([mainWt, featureWt])
    const { executeCommand, withProgress, quickInput } = renderEditor()
    await flush()

    openSyncPicker(quickInput).triggerOk()
    await flush()

    expect(withProgress).toHaveBeenCalledTimes(1)
    const options = withProgress.mock.calls[0]?.[0] as IProgressOptions
    expect(options.location).toBe(ProgressLocation.Notification)
    expect(options.title).toContain('main')
    // The task passed to withProgress is what actually executes the command.
    expect(executeCommand).toHaveBeenCalledWith(
      GitGraphCommands.syncWorktrees,
      'main',
      [{ path: featureWt.path, name: featureWt.name }],
      false,
    )
  })

  it('force-syncs the picked worktrees and preserves the force flag', async () => {
    gitGraphViewState.result = makeResult([mainWt, featureWt])
    const { executeCommand, quickInput } = renderEditor()
    await flush()

    const picker = openSyncPicker(quickInput, 'Force sync worktrees to main…')
    expect(picker.title).toContain('Force sync')
    expect(picker.okLabel).toBe('Force sync (1)')

    picker.triggerOk()
    await flush()

    // Same command as the plain entry, but with `force`: the extension side skips
    // the commit-message guard and resets any clean worktree.
    expect(executeCommand).toHaveBeenCalledWith(
      GitGraphCommands.syncWorktrees,
      'main',
      [{ path: featureWt.path, name: featureWt.name }],
      true,
    )
  })

  it('does not sync when the picker is cancelled', async () => {
    gitGraphViewState.result = makeResult([mainWt, featureWt])
    const { executeCommand, quickInput } = renderEditor()
    await flush()

    openSyncPicker(quickInput).hide()
    await flush()

    expect(syncCalls(executeCommand)).toEqual([])
  })

  it('opens the picker synchronously, before the menu-close flush', async () => {
    gitGraphViewState.result = makeResult([mainWt, featureWt])
    const { quickInput } = renderEditor()
    await flush()

    // No flush: `show()` has to happen inside the menu entry's own click
    // handler. Deferring it (e.g. awaiting before showing) would let the menu's
    // focus restore land after the panel's, leaving the input unfocused.
    expect(openSyncPicker(quickInput).shown).toBe(true)
  })

  it('syncs every candidate after the toolbar button re-selects them all', async () => {
    gitGraphViewState.result = makeResult([mainWt, zebraWt, appleWt])
    const { executeCommand, quickInput } = renderEditor()
    await flush()

    const picker = openSyncPicker(quickInput)
    // Clear, then select all: the single button slot flips both ways and the
    // confirm label tracks the checked count.
    picker.triggerButton()
    expect(picker.selectedItems).toEqual([])
    expect(picker.okLabel).toBe('Sync (0)')
    expect(picker.buttons[0]?.iconId).toBe('changelist')

    picker.triggerButton()
    expect(picker.selectedItems).toEqual(picker.rows)
    expect(picker.okLabel).toBe('Sync (2)')
    expect(picker.buttons[0]?.iconId).toBe('clear-all')

    picker.triggerOk()
    await flush()

    // Refs follow the graph's own payload order, not the picker's alphabetical one.
    expect(executeCommand).toHaveBeenCalledWith(
      GitGraphCommands.syncWorktrees,
      'main',
      [
        { path: zebraWt.path, name: zebraWt.name },
        { path: appleWt.path, name: appleWt.name },
      ],
      false,
    )
  })

  it('syncs only the worktrees left checked', async () => {
    gitGraphViewState.result = makeResult([mainWt, zebraWt, appleWt])
    const { executeCommand, quickInput } = renderEditor()
    await flush()

    const picker = openSyncPicker(quickInput)
    picker.toggle(appleWt.path)
    expect(picker.okLabel).toBe('Sync (1)')

    picker.triggerOk()
    await flush()

    expect(executeCommand).toHaveBeenCalledWith(
      GitGraphCommands.syncWorktrees,
      'main',
      [{ path: zebraWt.path, name: zebraWt.name }],
      false,
    )
  })

  it('does not sync once every row is unchecked', async () => {
    gitGraphViewState.result = makeResult([mainWt, featureWt])
    const { executeCommand, quickInput } = renderEditor()
    await flush()

    const picker = openSyncPicker(quickInput)
    picker.toggle(featureWt.path)
    expect(picker.okLabel).toBe('Sync (0)')

    picker.triggerOk()
    await flush()

    // The panel disables its confirm button on an empty set; the editor refuses
    // it too rather than running a sync over nothing.
    expect(syncCalls(executeCommand)).toEqual([])
  })

  it('lists the candidate worktrees in alphabetical order', async () => {
    // Feed them out of order; the picker must still offer apple before zebra.
    gitGraphViewState.result = makeResult([mainWt, zebraWt, appleWt])
    const { quickInput } = renderEditor()
    await flush()

    expect(openSyncPicker(quickInput).rows.map((it) => it.label)).toEqual(['apple', 'zebra'])
  })

  it('does nothing when the quick input service is unavailable', async () => {
    gitGraphViewState.result = makeResult([mainWt, featureWt])
    const { executeCommand } = renderEditor(true, { quickInput: 'none' })
    await flush()

    fireEvent.contextMenu(screen.getByText('✓ repo'))
    fireEvent.click(within(screen.getByRole('menu')).getByText('Sync worktrees to main…'))
    await flush()

    expect(syncCalls(executeCommand)).toEqual([])
  })

  it('reports the checked count and confirms with Enter through the real panel', async () => {
    gitGraphViewState.result = makeResult([mainWt, featureWt, detachedWt])
    const { executeCommand } = renderEditor(true, { quickInput: 'real' })
    await flush()

    const scrollBody = screen.getByTestId('gitGraph-scrollBody')
    scrollBody.focus()
    fireEvent.contextMenu(screen.getByText('✓ repo'))
    fireEvent.click(within(screen.getByRole('menu')).getByText('Sync worktrees to main…'))

    // The panel takes focus and shows the target branch + the live checked count.
    const field = screen.getByTestId('quick-input-field')
    expect(document.activeElement).toBe(field)
    expect(screen.getByTestId('quick-input-title').textContent).toContain('main')
    expect(screen.getByTestId('quick-input-ok').textContent).toBe('Sync (2)')
    expect(
      screen
        .getAllByTestId('quick-input-item-checkbox')
        .map((el) => el.getAttribute('aria-checked')),
    ).toEqual(['true', 'true'])

    // Space toggles the highlighted row (feature); the count follows.
    fireEvent.keyDown(field, { key: ' ' })
    expect(screen.getByTestId('quick-input-ok').textContent).toBe('Sync (1)')

    // The single toolbar button means "select all" while anything is unchecked…
    const toggleAll = screen.getByTestId('quick-input-button')
    fireEvent.click(toggleAll)
    expect(screen.getByTestId('quick-input-ok').textContent).toBe('Sync (2)')
    // …and "clear all" once everything is checked. It keeps focus on the input,
    // so Enter still confirms instead of re-triggering the button.
    fireEvent.click(toggleAll)
    expect(screen.getByTestId('quick-input-ok').textContent).toBe('Sync (0)')
    expect(document.activeElement).toBe(field)
    expect(screen.getByTestId('quick-input-ok')).toHaveProperty('disabled', true)

    fireEvent.click(toggleAll)
    expect(screen.getByTestId('quick-input-ok').textContent).toBe('Sync (2)')

    fireEvent.keyDown(field, { key: 'Enter' })
    await flush()

    expect(executeCommand).toHaveBeenCalledWith(
      GitGraphCommands.syncWorktrees,
      'main',
      [
        { path: featureWt.path, name: featureWt.name },
        { path: detachedWt.path, name: detachedWt.name },
      ],
      false,
    )
  })

  it('returns focus to the graph when the real panel is dismissed', async () => {
    gitGraphViewState.result = makeResult([mainWt, featureWt])
    renderEditor(true, { quickInput: 'real' })
    await flush()

    const scrollBody = screen.getByTestId('gitGraph-scrollBody')
    scrollBody.focus()
    fireEvent.contextMenu(screen.getByText('✓ repo'))
    fireEvent.click(within(screen.getByRole('menu')).getByText('Sync worktrees to main…'))

    fireEvent.keyDown(screen.getByTestId('quick-input-field'), { key: 'Escape' })
    await flush()

    expect(screen.queryByTestId('quick-input-field')).toBeNull()
    expect(document.activeElement).toBe(scrollBody)
  })

  it('reports a successful sync as a non-sticky notification instead of a dialog', async () => {
    gitGraphViewState.result = makeResult([mainWt, featureWt])
    const { quickInput, dialog, notify } = renderEditor(true, {
      commands: {
        syncResult: {
          synced: [featureWt.name],
          skippedDirty: [],
          skippedUnmatchedMessages: [],
          failed: [],
        },
      },
    })
    await flush()

    openSyncPicker(quickInput).triggerOk()
    await flush()

    const result = lastNotification(notify)
    expect(result?.message).toContain('Worktree sync to main')
    expect(result?.message).toContain('Synced: feature')
    expect(result?.severity).toBe(Severity.Info)
    expect(result?.sticky).toBe(false)
    expect(dialog.confirm).not.toHaveBeenCalled()
  })

  it('treats skipped worktrees as a successful sync', async () => {
    gitGraphViewState.result = makeResult([mainWt, featureWt])
    const { quickInput, notify } = renderEditor(true, {
      commands: {
        syncResult: {
          synced: [],
          skippedDirty: [featureWt.name],
          skippedUnmatchedMessages: [],
          failed: [],
        },
      },
    })
    await flush()

    openSyncPicker(quickInput).triggerOk()
    await flush()

    const result = lastNotification(notify)
    expect(result?.message).toContain('Skipped (uncommitted changes): feature')
    expect(result?.severity).toBe(Severity.Info)
    expect(result?.sticky).toBe(false)
  })

  it('reports a failed worktree reset as a sticky warning', async () => {
    gitGraphViewState.result = makeResult([mainWt, featureWt])
    const { quickInput, notify } = renderEditor(true, {
      commands: {
        syncResult: {
          synced: [],
          skippedDirty: [],
          skippedUnmatchedMessages: [],
          failed: [{ name: 'feature', error: 'boom' }],
        },
      },
    })
    await flush()

    openSyncPicker(quickInput).triggerOk()
    await flush()

    const result = lastNotification(notify)
    expect(result?.message).toContain('Failed: feature (boom)')
    expect(result?.severity).toBe(Severity.Warning)
    expect(result?.sticky).toBe(true)
  })

  it('reports an empty sync result with the nothing-to-do message', async () => {
    gitGraphViewState.result = makeResult([mainWt, featureWt])
    const { quickInput, notify } = renderEditor(true, {
      commands: {
        syncResult: {
          synced: [],
          skippedDirty: [],
          skippedUnmatchedMessages: [],
          failed: [],
        },
      },
    })
    await flush()

    openSyncPicker(quickInput).triggerOk()
    await flush()

    const result = lastNotification(notify)
    expect(result?.message).toContain('Nothing to do.')
    expect(result?.severity).toBe(Severity.Info)
    expect(result?.sticky).toBe(false)
  })
})

describe('GitGraphEditor worktree sync and push', () => {
  const syncedFeature: GitGraphWorktreeSyncResult = {
    synced: [featureWt.name],
    skippedDirty: [],
    skippedUnmatchedMessages: [],
    failed: [],
  }

  function syncCalls(executeCommand: ReturnType<typeof vi.fn>): unknown[][] {
    return executeCommand.mock.calls.filter((call) => call[0] === GitGraphCommands.syncWorktrees)
  }

  function pushCalls(executeCommand: ReturnType<typeof vi.fn>): unknown[][] {
    return executeCommand.mock.calls.filter((call) => call[0] === GitGraphCommands.pushBranch)
  }

  function combinedCalls(executeCommand: ReturnType<typeof vi.fn>): unknown[][] {
    return executeCommand.mock.calls.filter(
      (call) =>
        call[0] === GitGraphCommands.syncWorktrees || call[0] === GitGraphCommands.pushBranch,
    )
  }

  function openCombinedPicker(
    quickInput: FakeQuickInputService,
    label = 'Sync worktrees to main and push main…',
    badge = '✓ repo',
  ): FakeQuickPick<IQuickPickItem> {
    fireEvent.contextMenu(screen.getByText(badge))
    fireEvent.click(within(screen.getByRole('menu')).getByText(label))
    const picker = quickInput.picker
    if (!picker) throw new Error('the editor did not open a quick pick')
    return picker
  }

  it('offers the sync-and-push item between the plain and force sync items', async () => {
    gitGraphViewState.result = makeResult([mainWt, featureWt])
    renderEditor()
    await flush()

    fireEvent.contextMenu(screen.getByText('✓ repo'))
    const labels = within(screen.getByRole('menu'))
      .getAllByRole('menuitem')
      .map((el) => el.textContent)

    const plain = labels.indexOf('Sync worktrees to main…')
    const combined = labels.indexOf('Sync worktrees to main and push main…')
    const force = labels.indexOf('Force sync worktrees to main…')
    expect(plain).toBeGreaterThanOrEqual(0)
    expect(combined).toBe(plain + 1)
    expect(force).toBe(combined + 1)
  })

  it('labels the combined picker with the push step', async () => {
    gitGraphViewState.result = makeResult([mainWt, featureWt])
    const { quickInput } = renderEditor()
    await flush()

    const picker = openCombinedPicker(quickInput)
    expect(picker.title).toBe('Sync worktrees to main and push main')
    expect(picker.okLabel).toBe('Sync & push (1)')
  })

  it('syncs the picked worktrees first, then pushes main to origin', async () => {
    gitGraphViewState.result = makeResult([mainWt, featureWt])
    const { executeCommand, withProgress, quickInput, dialog, notify } = renderEditor(true, {
      commands: { syncResult: syncedFeature, pushResult: true },
    })
    await flush()

    openCombinedPicker(quickInput).triggerOk()
    await flush()

    expect(combinedCalls(executeCommand)).toEqual([
      [
        GitGraphCommands.syncWorktrees,
        'main',
        [{ path: featureWt.path, name: featureWt.name }],
        false,
      ],
      [GitGraphCommands.pushBranch, 'main', 'origin'],
    ])
    expect(withProgress).toHaveBeenCalledTimes(1)
    const options = withProgress.mock.calls[0]?.[0] as IProgressOptions
    expect(options.title).toContain('main')
    expect(options.title).toContain('push')
    const result = lastNotification(notify)
    expect(result?.message).toContain('Pushed main to origin.')
    expect(result?.message).not.toContain('\n')
    expect(result?.severity).toBe(Severity.Info)
    expect(result?.sticky).toBe(false)
    expect(dialog.confirm).not.toHaveBeenCalled()
  })

  it('pushes main even when the sync target is another branch', async () => {
    gitGraphViewState.result = makeResult([mainWt, featureWt])
    const { executeCommand, quickInput } = renderEditor(true, {
      commands: {
        syncResult: { ...syncedFeature, synced: [mainWt.name] },
        pushResult: true,
      },
    })
    await flush()

    openCombinedPicker(
      quickInput,
      'Sync worktrees to feature and push main…',
      'feature',
    ).triggerOk()
    await flush()

    expect(syncCalls(executeCommand)).toEqual([
      [
        GitGraphCommands.syncWorktrees,
        'feature',
        [{ path: mainWt.path, name: mainWt.name }],
        false,
      ],
    ])
    expect(pushCalls(executeCommand)).toEqual([[GitGraphCommands.pushBranch, 'main', 'origin']])
  })

  it('still pushes when the sync skips worktrees and reports both outcomes', async () => {
    gitGraphViewState.result = makeResult([mainWt, featureWt])
    const { executeCommand, quickInput, notify } = renderEditor(true, {
      commands: {
        syncResult: {
          synced: [],
          skippedDirty: [featureWt.name],
          skippedUnmatchedMessages: [],
          failed: [],
        },
        pushResult: true,
      },
    })
    await flush()

    openCombinedPicker(quickInput).triggerOk()
    await flush()

    expect(pushCalls(executeCommand)).toHaveLength(1)
    const result = lastNotification(notify)
    expect(result?.message).toContain('Skipped (uncommitted changes): feature')
    expect(result?.message).toContain('Pushed main to origin.')
    expect(result?.severity).toBe(Severity.Info)
    expect(result?.sticky).toBe(false)
  })

  it('does not sync or push when the picker is cancelled or emptied', async () => {
    gitGraphViewState.result = makeResult([mainWt, featureWt])
    const { executeCommand, quickInput } = renderEditor(true, {
      commands: { syncResult: syncedFeature, pushResult: true },
    })
    await flush()

    openCombinedPicker(quickInput).hide()
    await flush()
    expect(combinedCalls(executeCommand)).toEqual([])

    const picker = openCombinedPicker(quickInput)
    picker.toggle(featureWt.path)
    picker.triggerOk()
    await flush()
    expect(combinedCalls(executeCommand)).toEqual([])
  })

  it('reports a failed push without dropping the sync summary', async () => {
    gitGraphViewState.result = makeResult([mainWt, featureWt])
    const { quickInput, notify } = renderEditor(true, {
      commands: { syncResult: syncedFeature, pushResult: false },
    })
    await flush()

    openCombinedPicker(quickInput).triggerOk()
    await flush()

    const result = lastNotification(notify)
    expect(result?.message).toContain('Synced: feature')
    expect(result?.message).toContain('Push failed: main to origin.')
    expect(result?.severity).toBe(Severity.Warning)
    expect(result?.sticky).toBe(true)
  })

  it('treats a missing push result as a failure', async () => {
    gitGraphViewState.result = makeResult([mainWt, featureWt])
    const { quickInput, notify } = renderEditor(true, {
      commands: { syncResult: syncedFeature },
    })
    await flush()

    openCombinedPicker(quickInput).triggerOk()
    await flush()

    const result = lastNotification(notify)
    expect(result?.message).toContain('Push failed: main to origin.')
    expect(result?.severity).toBe(Severity.Warning)
    expect(result?.sticky).toBe(true)
  })

  it('keeps pushing when the sync command rejects', async () => {
    gitGraphViewState.result = makeResult([mainWt, featureWt])
    const { executeCommand, quickInput, notify } = renderEditor(true, {
      commands: { syncError: new Error('sync boom'), pushResult: true },
    })
    await flush()

    openCombinedPicker(quickInput).triggerOk()
    await flush()

    expect(pushCalls(executeCommand)).toHaveLength(1)
    const result = lastNotification(notify)
    expect(result?.message).toContain('Sync failed: sync boom')
    expect(result?.message).toContain('Pushed main to origin.')
    expect(result?.severity).toBe(Severity.Warning)
    expect(result?.sticky).toBe(true)
  })

  it('reports a missing sync result and still pushes', async () => {
    gitGraphViewState.result = makeResult([mainWt, featureWt])
    const { executeCommand, quickInput, notify } = renderEditor(true, {
      commands: { pushResult: true },
    })
    await flush()

    openCombinedPicker(quickInput).triggerOk()
    await flush()

    expect(pushCalls(executeCommand)).toHaveLength(1)
    const result = lastNotification(notify)
    expect(result?.message).toContain('Sync result unavailable.')
    expect(result?.message).toContain('Pushed main to origin.')
    expect(result?.severity).toBe(Severity.Warning)
    expect(result?.sticky).toBe(true)
  })

  it('reports a rejected push command', async () => {
    gitGraphViewState.result = makeResult([mainWt, featureWt])
    const { quickInput, notify } = renderEditor(true, {
      commands: { syncResult: syncedFeature, pushError: new Error('push boom') },
    })
    await flush()

    openCombinedPicker(quickInput).triggerOk()
    await flush()

    const result = lastNotification(notify)
    expect(result?.message).toContain('Push failed: main to origin.')
    expect(result?.severity).toBe(Severity.Warning)
    expect(result?.sticky).toBe(true)
  })

  it('treats a failed worktree reset as a warning that stays until dismissed', async () => {
    gitGraphViewState.result = makeResult([mainWt, featureWt])
    const { quickInput, notify } = renderEditor(true, {
      commands: {
        syncResult: { ...syncedFeature, synced: [], failed: [{ name: 'feature', error: 'boom' }] },
        pushResult: true,
      },
    })
    await flush()

    openCombinedPicker(quickInput).triggerOk()
    await flush()

    const result = lastNotification(notify)
    expect(result?.message).toContain('Failed: feature (boom)')
    expect(result?.severity).toBe(Severity.Warning)
    expect(result?.sticky).toBe(true)
  })
})

describe('GitGraphEditor ref overflow folding', () => {
  function makeRefResult(over: Partial<GitGraphLoadResult['commits'][number]>): GitGraphLoadResult {
    return {
      commits: [
        {
          hash: HASH,
          parents: [],
          author: 'tester',
          email: 't@example.com',
          date: 1,
          message: 'first',
          heads: [],
          tags: [],
          remotes: [],
          stash: null,
          worktrees: [],
          ...over,
        },
      ],
      head: HASH,
      headName: 'main',
      moreAvailable: false,
      uncommittedChanges: 0,
    }
  }

  it('shows all refs when they fit within the budget (no overflow badge)', async () => {
    gitGraphViewState.result = makeRefResult({ heads: ['main', 'a', 'b', 'c'] })
    renderEditor()
    await flush()

    expect(screen.getByText('main')).toBeTruthy()
    expect(screen.getByText('c')).toBeTruthy()
    expect(screen.queryByText(/^\+\d+$/)).toBeNull()
  })

  it('folds refs beyond the budget into a +N badge', async () => {
    gitGraphViewState.result = makeRefResult({ heads: ['main', 'a', 'b', 'c', 'd'] })
    renderEditor()
    await flush()

    // 5 refs > budget → show 3, fold 2.
    expect(screen.getByText('+2')).toBeTruthy()
  })

  it('keeps the HEAD branch visible and folds lower-priority refs', async () => {
    gitGraphViewState.result = makeRefResult({
      heads: ['main', 'a', 'b'],
      tags: [
        { name: 'v1', annotated: false },
        { name: 'v2', annotated: false },
      ],
    })
    renderEditor()
    await flush()

    // HEAD branch (main) outranks tags, so it stays inline; tags fold.
    expect(screen.getByText('main')).toBeTruthy()
    expect(screen.getByText('+2')).toBeTruthy()
    expect(screen.queryByText('v1')).toBeNull()
  })

  it('opens a menu listing the folded refs, each dispatching its kind', async () => {
    gitGraphViewState.result = makeRefResult({
      heads: ['main', 'a', 'b'],
      tags: [
        { name: 'v1', annotated: false },
        { name: 'v2', annotated: false },
      ],
    })
    const { executeCommand } = renderEditor()
    await flush()

    fireEvent.click(screen.getByText('+2'))
    const menu = screen.getByRole('menu')
    const labels = within(menu)
      .getAllByRole('menuitem')
      .map((el) => el.textContent)
    expect(labels).toContain('Tag v1')
    expect(labels).toContain('Tag v2')

    // Picking a folded tag opens that tag's own menu (push-tag dispatches its command).
    fireEvent.click(within(menu).getByText('Tag v1'))
    const tagMenu = screen.getByRole('menu')
    fireEvent.click(within(tagMenu).getByText(/Push tag/))
    expect(executeCommand).toHaveBeenCalledWith(GitGraphCommands.pushTag, 'v1', 'origin')
  })
})
