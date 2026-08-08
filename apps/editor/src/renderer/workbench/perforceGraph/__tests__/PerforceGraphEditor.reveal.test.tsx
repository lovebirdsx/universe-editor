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
  IStorageService,
  IViewDescriptorService,
  IViewsService,
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
  return { id, parents: [], author: 'alice', client: 'alice-ws', date: 1, message, body: message }
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

function renderEditor(
  getChanges: (options: { maxChanges?: number }) => P4GraphLoadResult | Promise<P4GraphLoadResult>,
) {
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
  services.set(IViewsService, {
    _serviceBrand: undefined,
    openViewContainer: vi.fn(),
  } as unknown as IViewsService)
  services.set(IViewDescriptorService, {
    _serviceBrand: undefined,
    setViewCollapsed: vi.fn(),
  } as unknown as IViewDescriptorService)
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
  // Several rounds: the storage-read → restore-decision → default-selection
  // chain schedules one React render per step.
  for (let round = 0; round < 10; round++) {
    await act(async () => {
      for (let i = 0; i < 8; i++) await Promise.resolve()
      await new Promise((resolve) => setTimeout(resolve, 0))
      for (let i = 0; i < 8; i++) await Promise.resolve()
    })
  }
}

function resetViewState(): void {
  perforceGraphViewState.revealCommit = null
  perforceGraphViewState.pendingReveal.set(null, undefined)
  perforceGraphViewState.result = null
  perforceGraphViewState.selection = []
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

    // The missing changelist never got selected — the open-time default selection stands.
    expect(perforceGraphViewState.selection).toEqual(['4521'])
    const pagedLimits = executeCommand.mock.calls
      .filter((c) => c[0] === PerforceGraphCommands.getChanges)
      .map((c) => (c[1] as { maxChanges?: number })?.maxChanges)
      .filter((n): n is number => typeof n === 'number' && n > PERFORCE_GRAPH_PAGE_SIZE)
    expect(pagedLimits).toHaveLength(20)
    expect(Math.max(...pagedLimits)).toBe(PERFORCE_GRAPH_PAGE_SIZE * 21)
  })

  it('consumes pendingReveal once the mounted editor finishes its first load', async () => {
    perforceGraphViewState.pendingReveal.set('4521', undefined)
    renderEditor(() => resultWith([change('4521', 'Fix widget')], false))
    await flush()

    expect(perforceGraphViewState.pendingReveal.get()).toBeNull()
    expect(perforceGraphViewState.selection).toEqual(['4521'])
  })

  it('consumes a pendingReveal that arrives while the editor is already mounted', async () => {
    // The `_workbench.openPerforceGraph` bridge always writes the observable
    // queue — the mounted editor must pick it up reactively (this is what makes
    // the reveal highlight robust across the openEditor tab-switch race).
    renderEditor(() => resultWith([change('4521', 'Fix widget')], false))
    await flush()
    // The open-time default selection already landed on the first row.
    expect(perforceGraphViewState.selection).toEqual(['4521'])

    await act(async () => {
      perforceGraphViewState.pendingReveal.set('4521', undefined)
      await flush()
    })

    expect(perforceGraphViewState.pendingReveal.get()).toBeNull()
    expect(perforceGraphViewState.selection).toEqual(['4521'])
    expect(scrollIntoViewSpy).toHaveBeenCalledWith({ block: 'center' })
  })

  it('keeps the reveal selection when an in-flight revalidate resolves after the reveal', async () => {
    // A cached result makes the mount dispatch a background revalidate (base
    // limit) instead of a fresh load.
    perforceGraphViewState.result = resultWith([change('4521', 'Fix widget')], true)
    let releaseRevalidate: (() => void) | undefined
    let call = 0
    renderEditor(async (options) => {
      if (++call === 1) {
        await new Promise<void>((r) => (releaseRevalidate = r))
        return resultWith([change('4521', 'Fix widget')], true)
      }
      return (options.maxChanges ?? 0) > PERFORCE_GRAPH_PAGE_SIZE
        ? resultWith([change('4521', 'Fix widget'), change('4000', 'Older')], true)
        : resultWith([change('4521', 'Fix widget')], true)
    })
    await flush()
    expect(releaseRevalidate).toBeDefined()

    // Reveal arrives while the mount revalidate is still in flight; it pages
    // in the target change and selects it.
    await act(async () => {
      perforceGraphViewState.revealCommit?.('4000')
      await flush()
    })
    expect(perforceGraphViewState.selection).toEqual(['4000'])

    // The stale revalidate lands last — it must not clobber the paged-in
    // result (which would filter the reveal selection out).
    await act(async () => {
      releaseRevalidate?.()
      await flush()
    })

    expect(perforceGraphViewState.selection).toEqual(['4000'])
    expect(perforceGraphViewState.result?.changes.some((c) => c.id === '4000')).toBe(true)
  })

  it('scrolls to a change that only exists after paging', async () => {
    renderEditor((options) =>
      (options.maxChanges ?? 0) > PERFORCE_GRAPH_PAGE_SIZE
        ? resultWith([change('4521', 'Fix widget'), change('4000', 'Older')], true)
        : resultWith([change('4521', 'Fix widget')], true),
    )
    await flush()

    await act(async () => {
      perforceGraphViewState.revealCommit?.('4000')
      await flush()
    })

    expect(perforceGraphViewState.selection).toEqual(['4000'])
    // The paged-in row enters the DOM only after React commits the reveal's
    // result — the scroll must wait for it rather than fire-and-forget.
    const scrolledRows = scrollIntoViewSpy.mock.contexts.map((el) =>
      (el as Element).getAttribute('data-id'),
    )
    expect(scrolledRows).toContain('4000')
  })

  it('keeps the reveal selection when the initial load resolves after the reveal', async () => {
    // First getChanges call (the initial load) stays pending until released;
    // any later call (the reveal's own paging) resolves immediately.
    let releaseInitialLoad: (() => void) | undefined
    let call = 0
    renderEditor(async () => {
      if (++call === 1) await new Promise<void>((r) => (releaseInitialLoad = r))
      return resultWith([change('4521', 'Fix widget')], false)
    })
    await flush()
    expect(releaseInitialLoad).toBeDefined()

    // Reveal arrives while the initial load is still in flight (the action
    // calls revealCommit right after openEditor resolves).
    await act(async () => {
      perforceGraphViewState.revealCommit?.('4521')
      await flush()
    })

    // The late initial load lands afterwards; its "fresh load" selection
    // reset must not clobber the reveal.
    await act(async () => {
      releaseInitialLoad?.()
      await flush()
    })

    expect(perforceGraphViewState.selection).toEqual(['4521'])
  })
})
