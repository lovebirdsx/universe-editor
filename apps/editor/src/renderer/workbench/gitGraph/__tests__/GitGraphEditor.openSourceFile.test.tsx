/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Regression coverage for Git Graph's "Open File" action in the changed-file
 *  tree. A single discovered nested repo may leave selectedRepo null while the
 *  graph itself is already showing that repo.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import {
  Event,
  ICommandService,
  IDialogService,
  IEditorResolverService,
  IFileService,
  INotificationService,
  IStorageService,
  InstantiationService,
  ServiceCollection,
  Severity,
  URI,
  observableValue,
  type IEditorResolverService as IEditorResolverServiceType,
  type IFileService as IFileServiceType,
  type INotificationService as INotificationServiceType,
} from '@universe-editor/platform'
import {
  GitGraphCommands,
  type GitGraphCommitDetailsDto,
  type GitGraphLoadResult,
  type GitGraphRepoDto,
} from '@universe-editor/extensions-common'
import { IScmService } from '../../../services/extensions/ScmService.js'
import { gitGraphViewState } from '../../../services/gitGraph/gitGraphViewState.js'
import { scmViewState } from '../../scm/scmViewState.js'
import { ServicesContext } from '../../useService.js'
import { GitGraphEditor } from '../GitGraphEditor.js'

const HASH = 'b2c4079fd07dfa7c73fee004e5a0736ff4a2dd80'
const REPO: GitGraphRepoDto = {
  root: 'G:/aki_3.4/Source/Client/TypeScript/Src/UniverseEditor',
  name: 'UniverseEditor',
}
const FILE_PATH = 'src/main.ts'

function makeResult(): GitGraphLoadResult {
  return {
    commits: [
      {
        hash: HASH,
        parents: ['1111111111111111111111111111111111111111'],
        author: 'tester',
        email: 't@example.com',
        date: 1,
        message: 'change file',
        heads: [],
        tags: [],
        remotes: [],
        stash: null,
        worktrees: [],
      },
    ],
    head: HASH,
    headName: 'main',
    moreAvailable: false,
    uncommittedChanges: 0,
  }
}

function makeDetails(): GitGraphCommitDetailsDto {
  return {
    hash: HASH,
    parents: ['1111111111111111111111111111111111111111'],
    author: 'tester',
    authorEmail: 't@example.com',
    authorDate: 1,
    committer: 'tester',
    committerEmail: 't@example.com',
    committerDate: 1,
    body: 'change file',
    files: [{ status: 'M', path: FILE_PATH, oldPath: null }],
  }
}

function makeCommandService(): ICommandService {
  return {
    _serviceBrand: undefined,
    executeCommand: vi.fn(async (id: string) => {
      switch (id) {
        case GitGraphCommands.getCommits:
          return makeResult()
        case GitGraphCommands.getRepos:
          return [REPO]
        case GitGraphCommands.getCommitDetails:
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

function makeStorage(): IStorageService {
  return {
    _serviceBrand: undefined,
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    onDidChangeWorkspaceScope: Event.None,
  } as unknown as IStorageService
}

function makeDialog(): IDialogService {
  return {
    _serviceBrand: undefined,
    confirm: vi.fn().mockResolvedValue({ confirmed: false }),
    prompt: vi.fn().mockResolvedValue(undefined),
  } as unknown as IDialogService
}

function makeFileService(exists: boolean): IFileServiceType {
  return {
    _serviceBrand: undefined,
    readFile: vi.fn(),
    readFileText: vi.fn(),
    writeFile: vi.fn(),
    exists: vi.fn().mockResolvedValue(exists),
    stat: vi.fn(),
    list: vi.fn(),
    createDirectory: vi.fn(),
    delete: vi.fn(),
    rename: vi.fn(),
    copy: vi.fn(),
    listRecursive: vi.fn(),
  } as unknown as IFileServiceType
}

function makeNotificationService(): INotificationServiceType {
  return {
    _serviceBrand: undefined,
    notifications: observableValue('test.notifications', []),
    unreadCount: observableValue('test.unreadCount', 0),
    centerVisible: observableValue('test.centerVisible', false),
    notify: vi.fn(() => ({
      id: 'n',
      progress: { report: vi.fn(), done: vi.fn() },
      updateMessage: vi.fn(),
      updateSeverity: vi.fn(),
      dispose: vi.fn(),
    })),
    prompt: vi.fn(),
    status: vi.fn(),
    dismiss: vi.fn(),
    cancelProgress: vi.fn(),
    clearAll: vi.fn(),
    toggleCenter: vi.fn(),
    markAllAsRead: vi.fn(),
  } as unknown as INotificationServiceType
}

function renderEditor(options: { fileExists: boolean; openError?: Error }) {
  const resolver: IEditorResolverServiceType = {
    _serviceBrand: undefined,
    registerEditor: vi.fn(),
    resolveEditors: vi.fn(() => []),
    openEditor: options.openError
      ? vi.fn().mockRejectedValue(options.openError)
      : vi.fn().mockResolvedValue(undefined),
  }
  const fileService = makeFileService(options.fileExists)
  const notification = makeNotificationService()

  const services = new ServiceCollection()
  services.set(ICommandService, makeCommandService())
  services.set(IScmService, makeScmService())
  services.set(IDialogService, makeDialog())
  services.set(IStorageService, makeStorage())
  services.set(IEditorResolverService, resolver)
  services.set(IFileService, fileService)
  services.set(INotificationService, notification)
  const instantiation = new InstantiationService(services)

  const utils = render(
    <ServicesContext.Provider value={instantiation}>
      <GitGraphEditor input={{} as never} />
    </ServicesContext.Provider>,
  )
  return { resolver, fileService, notification, ...utils }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

beforeEach(() => {
  gitGraphViewState.result = makeResult()
  gitGraphViewState.selection = [HASH]
  gitGraphViewState.details = makeDetails()
  gitGraphViewState.compareFiles = null
  gitGraphViewState.repos = [REPO]
  gitGraphViewState.selectedRepo = null
})

afterEach(() => {
  gitGraphViewState.result = null
  gitGraphViewState.selection = []
  gitGraphViewState.details = null
  gitGraphViewState.compareFiles = null
  gitGraphViewState.repos = []
  gitGraphViewState.selectedRepo = null
  scmViewState.setSelectedRepo(undefined)
  vi.clearAllMocks()
})

describe('GitGraphEditor open source file', () => {
  it('uses the discovered default repo when selectedRepo is null', async () => {
    const { resolver } = renderEditor({ fileExists: true })
    await flush()

    fireEvent.click(screen.getByTitle('Open File'))
    await flush()

    const expected = URI.joinPath(URI.file(REPO.root), FILE_PATH)
    expect(resolver.openEditor).toHaveBeenCalledWith(expected, { pinned: true })
  })

  it('notifies instead of silently failing when the working-tree file is missing', async () => {
    const { resolver, notification } = renderEditor({ fileExists: false })
    await flush()

    fireEvent.click(screen.getByTitle('Open File'))
    await flush()

    expect(resolver.openEditor).not.toHaveBeenCalled()
    expect(notification.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: Severity.Warning,
        message: expect.stringContaining('does not exist in the current working tree'),
      }),
    )
  })

  it('notifies instead of silently failing when the editor cannot open the file', async () => {
    const { notification } = renderEditor({
      fileExists: true,
      openError: new Error('permission denied'),
    })
    await flush()

    fireEvent.click(screen.getByTitle('Open File'))
    await flush()

    expect(notification.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: Severity.Error,
        message: expect.stringContaining('permission denied'),
      }),
    )
  })
})
