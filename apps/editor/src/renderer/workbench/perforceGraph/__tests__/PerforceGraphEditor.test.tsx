/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Coverage for the Perforce Graph editor: it loads submitted changes, renders
 *  rows, expands a change's detail on click, and opens a file diff.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import {
  Event,
  ICommandService,
  IEditorResolverService,
  IFileService,
  INotificationService,
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
import { ServicesContext } from '../../useService.js'
import { PerforceGraphEditor } from '../PerforceGraphEditor.js'

const REPO: P4GraphRepoDto = { root: 'C:/ws/main', name: 'alice-ws' }

function makeResult(): P4GraphLoadResult {
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
      { id: '4519', parents: [], author: 'bob', client: 'bob-ws', date: 1, message: 'Initial' },
    ],
    head: '4521',
    headClient: 'alice-ws',
    moreAvailable: false,
    pendingCount: 0,
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

function makeCommandService(): ICommandService {
  return {
    _serviceBrand: undefined,
    executeCommand: vi.fn(async (id: string) => {
      switch (id) {
        case PerforceGraphCommands.getChanges:
          return makeResult()
        case PerforceGraphCommands.getRepos:
          return [REPO]
        case PerforceGraphCommands.getChangeDetails:
          return makeDetails()
        default:
          return undefined
      }
    }),
    onWillExecuteCommand: Event.None,
    onDidExecuteCommand: Event.None,
  } as unknown as ICommandService
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

function makeFileService(exists = true): IFileService {
  return {
    _serviceBrand: undefined,
    exists: vi.fn(async () => exists),
  } as unknown as IFileService
}

function makeEditorResolverService(): IEditorResolverService {
  return {
    _serviceBrand: undefined,
    openEditor: vi.fn(async () => undefined),
  } as unknown as IEditorResolverService
}

function makeNotificationService(): INotificationService {
  return {
    _serviceBrand: undefined,
    notify: vi.fn(),
  } as unknown as INotificationService
}

function renderEditor() {
  const commandService = makeCommandService()
  const editorResolverService = makeEditorResolverService()
  const services = new ServiceCollection()
  services.set(ICommandService, commandService)
  services.set(IScmService, makeScmService())
  services.set(IFileService, makeFileService())
  services.set(IEditorResolverService, editorResolverService)
  services.set(INotificationService, makeNotificationService())
  const instantiation = new InstantiationService(services)
  const utils = render(
    <ServicesContext.Provider value={instantiation}>
      <PerforceGraphEditor input={{} as never} />
    </ServicesContext.Provider>,
  )
  return { commandService, editorResolverService, ...utils }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

beforeEach(() => {
  perforceGraphViewState.result = null
  perforceGraphViewState.selection = []
  perforceGraphViewState.details = null
  perforceGraphViewState.pendingFiles = null
  perforceGraphViewState.repos = []
  perforceGraphViewState.selectedRepo = null
})

afterEach(() => {
  perforceGraphViewState.result = null
  perforceGraphViewState.selection = []
  perforceGraphViewState.details = null
  perforceGraphViewState.pendingFiles = null
  perforceGraphViewState.repos = []
  perforceGraphViewState.selectedRepo = null
  scmViewState.setSelectedRepo(undefined)
  vi.clearAllMocks()
})

describe('PerforceGraphEditor', () => {
  it('loads and renders submitted changes newest-first', async () => {
    renderEditor()
    await flush()

    expect(screen.getByText('Fix widget')).toBeTruthy()
    expect(screen.getByText('Initial')).toBeTruthy()
    expect(screen.getByText('#4521')).toBeTruthy()
  })

  it('expands a change detail and opens a file diff', async () => {
    const { commandService } = renderEditor()
    await flush()

    fireEvent.click(screen.getByText('Fix widget'))
    await flush()

    // The change body + changed file appear in the detail panel.
    expect(screen.getByText('a.txt')).toBeTruthy()

    fireEvent.click(screen.getByText('a.txt'))
    await flush()

    expect(commandService.executeCommand).toHaveBeenCalledWith(PerforceGraphCommands.openFileDiff, {
      depotFile: '//depot/main/a.txt',
      status: 'M',
      rev: '3',
    })
  })

  it('opens the working-tree file via the resolver when the Open File icon is clicked', async () => {
    const { commandService, editorResolverService } = renderEditor()
    await flush()

    fireEvent.click(screen.getByText('Fix widget'))
    await flush()

    fireEvent.click(screen.getByTitle('Open File'))
    await flush()

    // The icon opens the local source file through the editor resolver — it does
    // NOT run a diff command like clicking the row does.
    const openEditor = editorResolverService.openEditor as unknown as ReturnType<typeof vi.fn>
    expect(openEditor).toHaveBeenCalledTimes(1)
    const [resource, options] = openEditor.mock.calls[0]!
    expect(resource.fsPath).toContain('a.txt')
    expect(options).toEqual({ pinned: true })
    expect(commandService.executeCommand).not.toHaveBeenCalledWith(
      PerforceGraphCommands.openWorkingTreeFile,
      expect.anything(),
    )
  })

  it('shows a pending-changes node when files are open', async () => {
    const withPending = makeResult()
    withPending.pendingCount = 2
    const services = new ServiceCollection()
    services.set(ICommandService, {
      _serviceBrand: undefined,
      executeCommand: vi.fn(async (id: string) => {
        if (id === PerforceGraphCommands.getChanges) return withPending
        if (id === PerforceGraphCommands.getRepos) return [REPO]
        return undefined
      }),
      onWillExecuteCommand: Event.None,
      onDidExecuteCommand: Event.None,
    } as unknown as ICommandService)
    services.set(IScmService, makeScmService())
    services.set(IFileService, makeFileService())
    services.set(IEditorResolverService, makeEditorResolverService())
    services.set(INotificationService, makeNotificationService())
    render(
      <ServicesContext.Provider value={new InstantiationService(services)}>
        <PerforceGraphEditor input={{} as never} />
      </ServicesContext.Provider>,
    )
    await flush()

    expect(screen.getByText('Pending Changes (2)')).toBeTruthy()
  })
})
