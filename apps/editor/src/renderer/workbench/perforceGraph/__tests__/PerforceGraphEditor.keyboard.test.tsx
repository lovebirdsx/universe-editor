/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Keyboard navigation for the Perforce Graph editor, mirroring the Git Graph
 *  behaviour: arrows / Home / End / PageUp / PageDown move the selection through
 *  the same entry point as mouse clicks, and Ctrl+Enter opens the selected
 *  change's context menu directly (a changelist row has exactly one menu
 *  target). The menu is keyboard-operable (arrows move, Enter runs, Escape
 *  closes).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
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
  type P4GraphChangeDetailsDto,
  type P4GraphLoadResult,
  type P4GraphRepoDto,
} from '@universe-editor/extensions-common'
import { IScmService } from '../../../services/extensions/ScmService.js'
import { perforceGraphViewState } from '../../../services/perforceGraph/perforceGraphViewState.js'
import { scmViewState } from '../../scm/scmViewState.js'
import { _clearGraphPayloadCacheForTests } from '../../scm/commitChanges/graphPayloadCache.js'
import { ServicesContext } from '../../useService.js'
import { ShowCommitChangesAction } from '../../../actions/commitChangesActions.js'
import { SendCommitToAgentChatAction } from '../../../actions/agentContextActions.js'
import { PerforceGraphEditor } from '../PerforceGraphEditor.js'

const REPO: P4GraphRepoDto = { root: 'C:/ws/main', name: 'alice-ws' }

function makeResult(pendingCount = 0): P4GraphLoadResult {
  return {
    changes: [
      {
        id: '4521',
        parents: ['4519'],
        author: 'alice',
        client: 'alice-ws',
        date: 1,
        message: 'Fix widget',
      },
      {
        id: '4519',
        parents: ['4500'],
        author: 'bob',
        client: 'bob-ws',
        date: 1,
        message: 'Middle',
      },
      {
        id: '4500',
        parents: [],
        author: 'carol',
        client: 'carol-ws',
        date: 1,
        message: 'Initial',
      },
    ],
    head: '4521',
    headClient: 'alice-ws',
    moreAvailable: false,
    pendingCount,
  }
}

function makeDetails(): P4GraphChangeDetailsDto {
  return {
    id: '4521',
    author: 'alice',
    client: 'alice-ws',
    date: 1,
    body: 'Fix widget',
    files: [
      {
        status: 'M',
        path: 'depot/main/a.txt',
        oldPath: null,
        depotFile: '//depot/main/a.txt',
        rev: '3',
        localPath: 'C:/ws/main/a.txt',
      },
    ],
  }
}

function renderEditor(pendingCount = 0) {
  const executeCommand = vi.fn(async (id: string) => {
    switch (id) {
      case PerforceGraphCommands.getChanges:
        return makeResult(pendingCount)
      case PerforceGraphCommands.getRepos:
        return [REPO]
      case PerforceGraphCommands.getChangeDetails:
        return makeDetails()
      default:
        return undefined
    }
  })
  const openViewContainer = vi.fn()
  const setViewCollapsed = vi.fn()
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
  services.set(IStorageService, {
    _serviceBrand: undefined,
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    onDidChangeWorkspaceScope: () => ({ dispose: () => {} }),
  } as unknown as IStorageService)
  services.set(IViewsService, {
    _serviceBrand: undefined,
    openViewContainer,
  } as unknown as IViewsService)
  services.set(IViewDescriptorService, {
    _serviceBrand: undefined,
    setViewCollapsed,
  } as unknown as IViewDescriptorService)
  const utils = render(
    <ServicesContext.Provider value={new InstantiationService(services)}>
      <PerforceGraphEditor input={{} as never} />
    </ServicesContext.Provider>,
  )
  return { executeCommand, openViewContainer, setViewCollapsed, ...utils }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

function resetViewState(): void {
  perforceGraphViewState.result = null
  perforceGraphViewState.selection = []
  perforceGraphViewState.repos = []
  perforceGraphViewState.selectedRepo = null
  perforceGraphViewState.wholeRepo = false
  perforceGraphViewState.searchQuery = ''
}

beforeEach(() => {
  resetViewState()
})

afterEach(() => {
  resetViewState()
  scmViewState.setSelectedRepo(undefined)
  _clearGraphPayloadCacheForTests()
  vi.clearAllMocks()
})

function scrollBody(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-testid="perforceGraph-scrollBody"]')!
}

function bridgeCalls(executeCommand: ReturnType<typeof vi.fn>): unknown[][] {
  return executeCommand.mock.calls.filter((c) => c[0] === ShowCommitChangesAction.ID)
}

function openMenu(): HTMLElement | null {
  return document.querySelector('[role="menu"]')
}

function menuLabels(): string[] {
  return [...document.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent ?? '')
}

describe('PerforceGraphEditor keyboard navigation', () => {
  it('ArrowDown/ArrowUp move the selection and drive the Commit Changes bridge', async () => {
    const { container, executeCommand } = renderEditor()
    await flush()

    const body = scrollBody(container)
    fireEvent.keyDown(body, { key: 'ArrowDown' })
    await flush()
    fireEvent.keyDown(body, { key: 'ArrowDown' })
    await flush()
    expect(perforceGraphViewState.selection).toEqual(['4519'])

    fireEvent.keyDown(body, { key: 'ArrowUp' })
    await flush()
    expect(perforceGraphViewState.selection).toEqual(['4521'])
    expect(bridgeCalls(executeCommand)).toHaveLength(3)
  })

  it('Home/End jump to the first/last loaded row', async () => {
    const { container } = renderEditor()
    await flush()

    const body = scrollBody(container)
    fireEvent.keyDown(body, { key: 'End' })
    await flush()
    expect(perforceGraphViewState.selection).toEqual(['4500'])

    fireEvent.keyDown(body, { key: 'Home' })
    await flush()
    expect(perforceGraphViewState.selection).toEqual(['4521'])
  })

  it('PageDown/PageUp move by the visible row count', async () => {
    const { container } = renderEditor()
    await flush()

    const body = scrollBody(container)
    Object.defineProperty(body, 'clientHeight', { configurable: true, value: 48 })
    fireEvent.keyDown(body, { key: 'ArrowDown' })
    await flush()
    fireEvent.keyDown(body, { key: 'PageDown' })
    await flush()
    expect(perforceGraphViewState.selection).toEqual(['4500'])

    fireEvent.keyDown(body, { key: 'PageUp' })
    await flush()
    expect(perforceGraphViewState.selection).toEqual(['4521'])
  })

  it('ArrowDown from the pending node moves to the first change', async () => {
    const { container, openViewContainer } = renderEditor(2)
    await flush()

    const body = scrollBody(container)
    fireEvent.keyDown(body, { key: 'ArrowDown' })
    await flush()
    expect(perforceGraphViewState.selection).toEqual(['*'])
    expect(openViewContainer).toHaveBeenCalledWith('workbench.view.scm')

    fireEvent.keyDown(body, { key: 'ArrowDown' })
    await flush()
    expect(perforceGraphViewState.selection).toEqual(['4521'])
  })

  it('does not swallow plain character keys', async () => {
    const { container } = renderEditor()
    await flush()

    const notPrevented = fireEvent.keyDown(scrollBody(container), { key: 'x' })
    expect(notPrevented).toBe(true)
    expect(perforceGraphViewState.selection).toEqual([])
  })
})

describe('PerforceGraphEditor menu focus on open', () => {
  // Driven through document.activeElement like a real browser: a keypress lands
  // on whatever holds focus, so a missing menu focus is directly observable.
  function pressKey(key: string, init: { ctrlKey?: boolean } = {}): void {
    fireEvent.keyDown(document.activeElement ?? document.body, { key, ...init })
  }

  it('Ctrl+Enter moves keyboard focus into the menu; arrows operate the menu, not the graph', async () => {
    const { container } = renderEditor()
    await flush()

    const body = scrollBody(container)
    body.focus()
    expect(document.activeElement).toBe(body)

    pressKey('ArrowDown')
    await flush()
    expect(perforceGraphViewState.selection).toEqual(['4521'])

    pressKey('Enter', { ctrlKey: true })
    await flush()

    const menu = openMenu()!
    expect(menu).not.toBeNull()
    expect(document.activeElement).toBe(menu)

    pressKey('ArrowDown')
    await flush()
    expect(menu.querySelector('[data-active]')?.textContent).toBe('Copy commit message')
    expect(perforceGraphViewState.selection).toEqual(['4521'])
  })
})

describe('PerforceGraphEditor Ctrl+Enter context menu', () => {
  it('opens the change menu directly (single menu target)', async () => {
    const { container } = renderEditor()
    await flush()

    const body = scrollBody(container)
    fireEvent.keyDown(body, { key: 'ArrowDown' })
    await flush()
    fireEvent.keyDown(body, { key: 'Enter', ctrlKey: true })
    await flush()

    expect(menuLabels()).toEqual([
      'Copy changelist number',
      'Copy commit message',
      'Send to Agent Chat',
    ])
  })

  it('opens no menu for the pending-changes node', async () => {
    const { container } = renderEditor(2)
    await flush()

    const body = scrollBody(container)
    fireEvent.keyDown(body, { key: 'ArrowDown' })
    await flush()
    fireEvent.keyDown(body, { key: 'Enter', ctrlKey: true })
    await flush()
    expect(openMenu()).toBeNull()
  })

  it('menu keyboard: arrows skip separators, Enter runs, Escape closes', async () => {
    const { container, executeCommand } = renderEditor()
    await flush()

    const body = scrollBody(container)
    fireEvent.keyDown(body, { key: 'ArrowDown' })
    await flush()
    fireEvent.keyDown(body, { key: 'Enter', ctrlKey: true })
    await flush()

    const menu = openMenu()!
    expect(menu.querySelector('[data-active]')?.textContent).toBe('Copy changelist number')

    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(menu.querySelector('[data-active]')?.textContent).toBe('Send to Agent Chat')

    fireEvent.keyDown(menu, { key: 'Enter' })
    await flush()
    expect(executeCommand).toHaveBeenCalledWith(SendCommitToAgentChatAction.ID, {
      hash: '4521',
      message: 'Fix widget',
    })
    expect(openMenu()).toBeNull()
  })
})
