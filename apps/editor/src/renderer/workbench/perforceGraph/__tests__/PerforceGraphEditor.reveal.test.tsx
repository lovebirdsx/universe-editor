/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Coverage for the reveal bridge (`_workbench.openPerforceGraph` → viewState):
 *  an already-loaded changelist is selected in place; an unloaded one pages in
 *  older history (bounded by the reveal page cap); a reveal requested while
 *  the tab was unmounted is consumed from pendingReveal after the first load.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import {
  Event,
  ICommandService,
  IEditorResolverService,
  IFileService,
  INotificationService,
  IStorageService,
  InstantiationService,
  ServiceCollection,
  observableValue,
} from '@universe-editor/platform'
import {
  PerforceGraphCommands,
  type P4GraphChangeDto,
  type P4GraphLoadResult,
  type P4GraphRepoDto,
} from '@universe-editor/extensions-common'
import { IScmService } from '../../../services/extensions/ScmService.js'
import {
  PERFORCE_GRAPH_PAGE_SIZE,
  perforceGraphViewState,
} from '../../../services/perforceGraph/perforceGraphViewState.js'
import { scmViewState } from '../../scm/scmViewState.js'
import { ServicesContext } from '../../useService.js'
import { PerforceGraphEditor } from '../PerforceGraphEditor.js'

const REPO: P4GraphRepoDto = { root: 'C:/ws/main', name: 'alice-ws' }

function change(id: string, message: string): P4GraphChangeDto {
  return { id, parents: [], author: 'alice', client: 'alice-ws', date: 1, message }
}

function resultWith(changes: P4GraphChangeDto[], moreAvailable: boolean): P4GraphLoadResult {
  return {
    changes,
    head: changes[0]?.id ?? null,
    headClient: 'alice-ws',
    moreAvailable,
    pendingCount: 0,
  }
}

function renderEditor(getChanges: (options: { maxChanges?: number }) => P4GraphLoadResult) {
  const executeCommand = vi.fn(async (id: string, arg?: { maxChanges?: number }) => {
    switch (id) {
      case PerforceGraphCommands.getChanges:
        return getChanges(arg ?? {})
      case PerforceGraphCommands.getRepos:
        return [REPO]
      default:
        return undefined
    }
  })
  const services = new ServiceCollection()
  services.set(ICommandService, {
    _serviceBrand: undefined,
    executeCommand,
    onWillExecuteCommand: Event.None,
    onDidExecuteCommand: Event.None,
  } as unknown as ICommandService)
  services.set(IScmService, {
    _serviceBrand: undefined,
    sourceControls: observableValue('test.sourceControls', []),
    changeInputBoxValue: vi.fn(),
    setExtHost: vi.fn(),
    resetSourceControls: vi.fn(),
  } as unknown as IScmService)
  services.set(IFileService, {
    _serviceBrand: undefined,
    exists: vi.fn(async () => true),
  } as unknown as IFileService)
  services.set(IEditorResolverService, {
    _serviceBrand: undefined,
    openEditor: vi.fn(async () => undefined),
  } as unknown as IEditorResolverService)
  services.set(INotificationService, {
    _serviceBrand: undefined,
    notify: vi.fn(),
  } as unknown as INotificationService)
  services.set(IStorageService, {
    _serviceBrand: undefined,
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    onDidChangeWorkspaceScope: () => ({ dispose: () => {} }),
  } as unknown as IStorageService)
  const utils = render(
    <ServicesContext.Provider value={new InstantiationService(services)}>
      <PerforceGraphEditor input={{} as never} />
    </ServicesContext.Provider>,
  )
  return { executeCommand, ...utils }
}

// Wrapped in act: exiting act flushes React's passive effects, which is what
// re-registers viewState.revealCommit with a fresh result/limit closure after
// the initial load (a bare setTimeout flush races the scheduler).
async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
}

function resetViewState(): void {
  perforceGraphViewState.revealCommit = null
  perforceGraphViewState.pendingReveal = null
  perforceGraphViewState.result = null
  perforceGraphViewState.selection = []
  perforceGraphViewState.details = null
  perforceGraphViewState.pendingFiles = null
  perforceGraphViewState.repos = []
  perforceGraphViewState.selectedRepo = null
  perforceGraphViewState.searchQuery = ''
  perforceGraphViewState.limit = PERFORCE_GRAPH_PAGE_SIZE
  perforceGraphViewState.wholeRepo = false
}

let scrollIntoViewSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  resetViewState()
  scrollIntoViewSpy = vi.fn()
  Element.prototype.scrollIntoView = scrollIntoViewSpy
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
    cb(0)
    return 0
  })
})

afterEach(() => {
  resetViewState()
  scmViewState.setSelectedRepo(undefined)
  vi.restoreAllMocks()
})

describe('PerforceGraphEditor reveal', () => {
  it('selects an already-loaded change in place without paging', async () => {
    const { executeCommand } = renderEditor(() => resultWith([change('4521', 'Fix widget')], false))
    await flush()

    await act(async () => {
      perforceGraphViewState.revealCommit?.('4521')
    })
    await flush()

    expect(perforceGraphViewState.selection).toEqual(['4521'])
    expect(scrollIntoViewSpy).toHaveBeenCalledWith({ block: 'center' })
    const pagedLimits = executeCommand.mock.calls
      .filter((c) => c[0] === PerforceGraphCommands.getChanges)
      .map((c) => (c[1] as { maxChanges?: number })?.maxChanges)
      .filter((n): n is number => typeof n === 'number' && n > PERFORCE_GRAPH_PAGE_SIZE)
    expect(pagedLimits).toHaveLength(0)
  })

  it('pages in older history with a growing maxChanges until the change is loaded', async () => {
    const { executeCommand } = renderEditor((options) =>
      (options.maxChanges ?? 0) > PERFORCE_GRAPH_PAGE_SIZE
        ? resultWith([change('4521', 'Fix widget'), change('4000', 'Older')], true)
        : resultWith([change('4521', 'Fix widget')], true),
    )
    await flush()

    await act(async () => {
      perforceGraphViewState.revealCommit?.('4000')
    })
    await flush()

    expect(perforceGraphViewState.selection).toEqual(['4000'])
    expect(perforceGraphViewState.limit).toBe(PERFORCE_GRAPH_PAGE_SIZE * 2)
    const pagedLimits = executeCommand.mock.calls
      .filter((c) => c[0] === PerforceGraphCommands.getChanges)
      .map((c) => (c[1] as { maxChanges?: number })?.maxChanges)
    expect(pagedLimits).toContain(PERFORCE_GRAPH_PAGE_SIZE * 2)
  })

  it('stops paging at the reveal page cap and leaves the selection untouched', async () => {
    const { executeCommand } = renderEditor(() => resultWith([change('4521', 'Fix widget')], true))
    await flush()

    await act(async () => {
      perforceGraphViewState.revealCommit?.('9999')
    })
    await flush()

    expect(perforceGraphViewState.selection).toEqual([])
    const pagedLimits = executeCommand.mock.calls
      .filter((c) => c[0] === PerforceGraphCommands.getChanges)
      .map((c) => (c[1] as { maxChanges?: number })?.maxChanges)
      .filter((n): n is number => typeof n === 'number' && n > PERFORCE_GRAPH_PAGE_SIZE)
    expect(pagedLimits).toHaveLength(20)
    expect(Math.max(...pagedLimits)).toBe(PERFORCE_GRAPH_PAGE_SIZE * 21)
  })

  it('consumes pendingReveal once the mounted editor finishes its first load', async () => {
    perforceGraphViewState.pendingReveal = '4521'
    renderEditor(() => resultWith([change('4521', 'Fix widget')], false))
    await flush()

    expect(perforceGraphViewState.pendingReveal).toBeNull()
    expect(perforceGraphViewState.selection).toEqual(['4521'])
  })
})
