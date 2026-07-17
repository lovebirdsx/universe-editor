/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Swarm review restore + changed-file list/tree regressions.
 *--------------------------------------------------------------------------------------------*/

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  ICommandService,
  IConfigurationService,
  IDialogService,
  IEditorService,
  IOpenerService,
  IStorageService,
  InstantiationService,
  ServiceCollection,
  URI,
  type ICommand,
} from '@universe-editor/platform'
import {
  SwarmCommands,
  type SwarmReviewDetailDto,
  type SwarmReviewFileDto,
} from '@universe-editor/extensions-common'
import { ServicesContext } from '../../useService.js'
import { SwarmReviewEditorInput } from '../../../services/editor/SwarmReviewEditorInput.js'
import { SwarmDiffEditorInput } from '../../../services/editor/SwarmDiffEditorInput.js'
import { DiffEditorInput } from '../../../services/editor/DiffEditorInput.js'
import {
  swarmReviewDetailCache,
  clearSwarmReviewEditorStates,
} from '../../../services/swarm/swarmViewState.js'
import { SwarmReviewEditor } from '../SwarmReviewEditor.js'
import { SwarmReviewFiles } from '../SwarmReviewFiles.js'

const DETAIL: SwarmReviewDetailDto = {
  id: '1001',
  state: 'needsReview',
  stateLabel: 'Needs Review',
  author: 'alice',
  description: 'Restore this review',
  updated: 1,
  versions: [{ version: 1, change: '2001', pending: true, time: 1 }],
  participants: [],
  transitions: [],
  commentCount: 0,
  openTaskCount: 0,
  testStatus: 'none',
}

const FILES: SwarmReviewFileDto[] = [
  {
    status: 'M',
    path: 'src/editor/a.ts',
    depotFile: '//depot/src/editor/a.ts',
    baseRevision: '1',
    localPath: 'C:/workspace/src/editor/a.ts',
  },
  {
    status: 'A',
    path: 'src/runtime/b.ts',
    depotFile: '//depot/src/runtime/b.ts',
    baseRevision: null,
    localPath: 'C:/workspace/src/runtime/b.ts',
  },
]

const FILES_WITH_SPREADSHEET: SwarmReviewFileDto[] = [
  {
    status: 'M',
    path: 'tables/buff.xlsx',
    depotFile: '//depot/tables/buff.xlsx',
    baseRevision: '3',
    localPath: 'C:/workspace/tables/buff.xlsx',
  },
]

const DETAIL_WITH_NEW_VERSION: SwarmReviewDetailDto = {
  ...DETAIL,
  versions: [...DETAIL.versions, { version: 2, change: '2002', pending: true, time: 2 }],
}

// Two versions where the latest carries an immutable archiveChange (the author's
// changelist 2002 can be re-shelved / emptied after the version was recorded).
const DETAIL_WITH_ARCHIVE: SwarmReviewDetailDto = {
  ...DETAIL,
  versions: [
    { version: 1, change: '2001', pending: true, time: 1 },
    { version: 2, change: '2002', archiveChange: '2999', pending: true, time: 2 },
  ],
}

class RegistryCommandService {
  declare readonly _serviceBrand: undefined
  readonly executeCommand = vi.fn(async <T,>(id: string, ...args: unknown[]) => {
    const command = CommandsRegistry.getCommand(id)
    if (!command) return undefined
    return command.handler({ get: () => undefined } as never, ...args) as T
  })
}

class FakeStorage {
  declare readonly _serviceBrand: undefined
  async get<T>(): Promise<T | undefined> {
    return undefined
  }
  async set(): Promise<void> {}
  async remove(): Promise<void> {}
}

function registerCommand(id: string, handler: ICommand['handler']) {
  return CommandsRegistry.registerCommand({ id, handler })
}

function renderReview() {
  const services = new ServiceCollection()
  const commands = new RegistryCommandService()
  services.set(ICommandService, commands as unknown as ICommandService)
  services.set(IConfigurationService, {
    _serviceBrand: undefined,
    get: (key: string) =>
      key === 'perforce.swarm.url' ? 'https://swarm.example.com///' : undefined,
  } as unknown as IConfigurationService)
  const dialog = {
    _serviceBrand: undefined,
    confirm: vi.fn(async () => ({ confirmed: false })),
  }
  services.set(IDialogService, dialog as unknown as IDialogService)
  const editorService = {
    _serviceBrand: undefined,
    openEditor: vi.fn(),
    closeEditor: vi.fn(),
  }
  services.set(IEditorService, editorService as unknown as IEditorService)
  const opener = {
    _serviceBrand: undefined,
    open: vi.fn(async () => true),
  }
  services.set(IOpenerService, opener as unknown as IOpenerService)
  services.set(IStorageService, new FakeStorage() as unknown as IStorageService)
  const instantiation = new InstantiationService(services)
  const input = new SwarmReviewEditorInput('1001')
  const result = render(
    <ServicesContext.Provider value={instantiation}>
      <SwarmReviewEditor input={input} />
    </ServicesContext.Provider>,
  )
  return { ...result, commands, dialog, editorService, input, opener }
}

beforeEach(() => {
  vi.useFakeTimers()
  swarmReviewDetailCache.clear()
  clearSwarmReviewEditorStates()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  swarmReviewDetailCache.clear()
  clearSwarmReviewEditorStates()
})

describe('SwarmReviewEditor restore', () => {
  it('opens the linked review title in the external opener', async () => {
    const getReview = registerCommand(SwarmCommands.getReview, () => DETAIL)
    const { opener } = renderReview()
    try {
      await act(async () => Promise.resolve())

      const title = screen.getByRole('link', { name: 'Review #1001' })
      expect(title.getAttribute('href')).toBe('https://swarm.example.com/reviews/1001')
      fireEvent.click(title)

      expect(opener.open).toHaveBeenCalledWith('https://swarm.example.com/reviews/1001', {
        fromUserGesture: true,
      })
    } finally {
      getReview.dispose()
    }
  })

  it('does not obliterate the review when confirmation is cancelled', async () => {
    const getReview = registerCommand(SwarmCommands.getReview, () => DETAIL)
    const { commands, editorService } = renderReview()
    try {
      await act(async () => Promise.resolve())
      await act(async () =>
        fireEvent.click(screen.getByRole('button', { name: 'Obliterate Review' })),
      )

      expect(commands.executeCommand).not.toHaveBeenCalledWith(SwarmCommands.obliterateReview, {
        reviewId: '1001',
      })
      expect(editorService.closeEditor).not.toHaveBeenCalled()
    } finally {
      getReview.dispose()
    }
  })

  it('obliterates a confirmed review, clears its cache, and closes the editor', async () => {
    const getReview = registerCommand(SwarmCommands.getReview, () => DETAIL)
    const obliterate = registerCommand(SwarmCommands.obliterateReview, () => true)
    const { commands, dialog, editorService, input } = renderReview()
    dialog.confirm.mockResolvedValueOnce({ confirmed: true })
    try {
      await act(async () => Promise.resolve())
      expect(swarmReviewDetailCache.has('1001')).toBe(true)

      await act(async () =>
        fireEvent.click(screen.getByRole('button', { name: 'Obliterate Review' })),
      )

      expect(commands.executeCommand).toHaveBeenCalledWith(SwarmCommands.obliterateReview, {
        reviewId: '1001',
      })
      expect(swarmReviewDetailCache.has('1001')).toBe(false)
      expect(editorService.closeEditor).toHaveBeenCalledWith(input.id)
    } finally {
      obliterate.dispose()
      getReview.dispose()
    }
  })

  it('opens a first-version edit against its depot base instead of an empty file', async () => {
    const getReview = registerCommand(SwarmCommands.getReview, () => DETAIL)
    const describeVersion = registerCommand(SwarmCommands.describeVersion, () => FILES)
    const getFileContent = registerCommand(
      SwarmCommands.getFileContent,
      (_accessor, request: unknown) =>
        (request as { revision: string }).revision === '#1'
          ? 'export const a = 1\n'
          : 'export const a = 2\n',
    )
    const { commands, editorService } = renderReview()
    try {
      await act(async () => Promise.resolve())
      fireEvent.click(screen.getByText('a.ts'))
      await act(async () => Promise.resolve())

      expect(commands.executeCommand).toHaveBeenCalledWith(SwarmCommands.getFileContent, {
        depotFile: '//depot/src/editor/a.ts',
        revision: '#1',
      })
      expect(commands.executeCommand).toHaveBeenCalledWith(SwarmCommands.getFileContent, {
        depotFile: '//depot/src/editor/a.ts',
        revision: '@=2001',
      })
      const diffInput = editorService.openEditor.mock.calls[0]?.[0] as SwarmDiffEditorInput
      expect(diffInput).toBeInstanceOf(SwarmDiffEditorInput)
      expect(diffInput).toBeInstanceOf(DiffEditorInput)
      expect(diffInput.openableResource?.toString()).toBe(
        URI.file('C:/workspace/src/editor/a.ts').toString(),
      )
      expect(diffInput.originalContent).toBe('export const a = 1\n')
      expect(diffInput.modifiedContent).toBe('export const a = 2\n')
      expect(diffInput.context.leftVersion).toBe(0)
      expect(diffInput.context.rightVersion).toBe(1)
      expect(diffInput.getName()).toBe('a.ts (base ↔ v1)')
    } finally {
      getFileContent.dispose()
      describeVersion.dispose()
      getReview.dispose()
    }
  })

  it('diffs a spreadsheet file through the Excel webview instead of the empty text diff', async () => {
    const getReview = registerCommand(SwarmCommands.getReview, () => DETAIL)
    const describeVersion = registerCommand(
      SwarmCommands.describeVersion,
      () => FILES_WITH_SPREADSHEET,
    )
    // Text print must not be used for a binary xlsx (UTF-8 decoding corrupts bytes).
    const getFileContent = registerCommand(SwarmCommands.getFileContent, () => 'CORRUPTED')
    const getFileContentBytes = registerCommand(
      SwarmCommands.getFileContentBytes,
      (_accessor, request: unknown) =>
        (request as { revision: string }).revision === '#3'
          ? Buffer.from('LEFT-BYTES').toString('base64')
          : Buffer.from('RIGHT-BYTES').toString('base64'),
    )
    const { commands, editorService } = renderReview()
    try {
      await act(async () => Promise.resolve())
      fireEvent.click(screen.getByText('buff.xlsx'))
      await act(async () => Promise.resolve())

      // Binary content command is used for both sides, not the utf8 text print.
      expect(commands.executeCommand).toHaveBeenCalledWith(SwarmCommands.getFileContentBytes, {
        depotFile: '//depot/tables/buff.xlsx',
        revision: '#3',
      })
      expect(commands.executeCommand).toHaveBeenCalledWith(SwarmCommands.getFileContentBytes, {
        depotFile: '//depot/tables/buff.xlsx',
        revision: '@=2001',
      })
      expect(commands.executeCommand).not.toHaveBeenCalledWith(
        SwarmCommands.getFileContent,
        expect.anything(),
      )

      // The diff is handed to the webview custom editor, not a Monaco text diff.
      expect(editorService.openEditor).not.toHaveBeenCalled()
      const call = commands.executeCommand.mock.calls.find(
        ([id]) => id === '_workbench.openWebviewDiff',
      )
      expect(call).toBeTruthy()
      const payload = call?.[1] as {
        viewType: string
        leftBase64: string
        rightBase64: string
      }
      expect(payload.viewType).toBe('universe.excel')
      expect(Buffer.from(payload.leftBase64, 'base64').toString()).toBe('LEFT-BYTES')
      expect(Buffer.from(payload.rightBase64, 'base64').toString()).toBe('RIGHT-BYTES')
    } finally {
      getFileContentBytes.dispose()
      getFileContent.dispose()
      describeVersion.dispose()
      getReview.dispose()
    }
  })

  it('lists the latest version files from its immutable archive shelf, not the mutable changelist', async () => {
    const getReview = registerCommand(SwarmCommands.getReview, () => DETAIL_WITH_ARCHIVE)
    const describeVersion = registerCommand(SwarmCommands.describeVersion, () => FILES)
    const listComments = registerCommand(SwarmCommands.listComments, () => [])
    const { commands } = renderReview()
    try {
      await act(async () => Promise.resolve())

      expect(commands.executeCommand).toHaveBeenCalledWith(SwarmCommands.describeVersion, {
        change: '2999',
        immutable: true,
      })
      expect(commands.executeCommand).not.toHaveBeenCalledWith(SwarmCommands.describeVersion, {
        change: '2002',
      })
    } finally {
      listComments.dispose()
      describeVersion.dispose()
      getReview.dispose()
    }
  })

  it('diffs a multi-version file against the depot base by default, not the previous version', async () => {
    const getReview = registerCommand(SwarmCommands.getReview, () => DETAIL_WITH_ARCHIVE)
    const describeVersion = registerCommand(SwarmCommands.describeVersion, () => FILES)
    const listComments = registerCommand(SwarmCommands.listComments, () => [])
    const getFileContent = registerCommand(
      SwarmCommands.getFileContent,
      (_accessor, request: unknown) =>
        (request as { revision: string }).revision === '#1'
          ? 'export const a = 1\n'
          : 'export const a = 2\n',
    )
    const { commands, editorService } = renderReview()
    try {
      await act(async () => Promise.resolve())
      fireEvent.click(screen.getByText('a.ts'))
      await act(async () => Promise.resolve())

      // Left = depot base (#baseRevision), right = the selected version's archive shelf.
      expect(commands.executeCommand).toHaveBeenCalledWith(SwarmCommands.getFileContent, {
        depotFile: '//depot/src/editor/a.ts',
        revision: '#1',
      })
      expect(commands.executeCommand).toHaveBeenCalledWith(SwarmCommands.getFileContent, {
        depotFile: '//depot/src/editor/a.ts',
        revision: '@=2999',
      })
      const diffInput = editorService.openEditor.mock.calls[0]?.[0] as SwarmDiffEditorInput
      expect(diffInput.context.leftVersion).toBe(0)
      expect(diffInput.context.rightVersion).toBe(2)
      expect(diffInput.originalContent).toBe('export const a = 1\n')
      expect(diffInput.modifiedContent).toBe('export const a = 2\n')
    } finally {
      getFileContent.dispose()
      listComments.dispose()
      describeVersion.dispose()
      getReview.dispose()
    }
  })

  it('waits for the runtime command instead of treating startup undefined as a missing review', async () => {
    const { commands } = renderReview()

    await act(async () => Promise.resolve())
    expect(commands.executeCommand).not.toHaveBeenCalledWith(SwarmCommands.getReview, {
      reviewId: '1001',
    })
    expect(screen.queryByText('Review #1001 is unavailable.')).toBeNull()

    const registration = registerCommand(SwarmCommands.getReview, () => DETAIL)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })

    expect(screen.getByText('Review #1001')).toBeTruthy()
    expect(screen.getByText('Restore this review')).toBeTruthy()

    const describeRegistration = registerCommand(SwarmCommands.describeVersion, () => FILES)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })
    expect(screen.getByText('a.ts')).toBeTruthy()

    describeRegistration.dispose()
    registration.dispose()
  })

  it('still reports a missing review after the command is registered', async () => {
    const registration = registerCommand(SwarmCommands.getReview, () => undefined)
    renderReview()

    await act(async () => Promise.resolve())

    expect(screen.getByText('Review #1001 is unavailable.')).toBeTruthy()
    registration.dispose()
  })

  it('manually refreshes review detail, comments, and version files', async () => {
    const getReview = registerCommand(SwarmCommands.getReview, () => DETAIL)
    const listComments = registerCommand(SwarmCommands.listComments, () => [])
    const describeVersion = registerCommand(SwarmCommands.describeVersion, () => FILES)
    const { commands } = renderReview()
    try {
      await act(async () => Promise.resolve())
      commands.executeCommand.mockClear()

      fireEvent.click(screen.getByRole('button', { name: 'Refresh review' }))
      await act(async () => Promise.resolve())

      expect(commands.executeCommand).toHaveBeenCalledWith(SwarmCommands.getReview, {
        reviewId: '1001',
        force: true,
      })
      expect(commands.executeCommand).toHaveBeenCalledWith(SwarmCommands.listComments, {
        reviewId: '1001',
        force: true,
      })
      expect(commands.executeCommand).toHaveBeenCalledWith(SwarmCommands.describeVersion, {
        change: '2001',
        force: true,
      })
    } finally {
      describeVersion.dispose()
      listComments.dispose()
      getReview.dispose()
    }
  })

  it('describes an archive-shelf version as immutable and skips it on refresh ticks', async () => {
    const getReview = registerCommand(SwarmCommands.getReview, () => DETAIL_WITH_ARCHIVE)
    const listComments = registerCommand(SwarmCommands.listComments, () => [])
    let describeCalls = 0
    const describeVersion = registerCommand(SwarmCommands.describeVersion, () => {
      describeCalls++
      return FILES
    })
    const { commands } = renderReview()
    try {
      await act(async () => Promise.resolve())

      // Selected the latest version (2), whose archiveChange is 2999 — described
      // once as an immutable snapshot (never with force).
      expect(commands.executeCommand).toHaveBeenCalledWith(SwarmCommands.describeVersion, {
        change: '2999',
        immutable: true,
      })
      expect(describeCalls).toBe(1)

      // Minute-interval auto-refresh must NOT re-run describe for the immutable
      // archive shelf — that churn is exactly the reported regression.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000)
      })
      expect(describeCalls).toBe(1)
      expect(commands.executeCommand).not.toHaveBeenCalledWith(SwarmCommands.describeVersion, {
        change: '2999',
        force: true,
      })
    } finally {
      describeVersion.dispose()
      listComments.dispose()
      getReview.dispose()
    }
  })

  it('automatically refreshes an open review every minute', async () => {
    const getReview = registerCommand(SwarmCommands.getReview, () => DETAIL)
    const listComments = registerCommand(SwarmCommands.listComments, () => [])
    const describeVersion = registerCommand(SwarmCommands.describeVersion, () => FILES)
    const { commands, unmount } = renderReview()
    try {
      await act(async () => Promise.resolve())
      commands.executeCommand.mockClear()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000)
      })

      expect(commands.executeCommand).toHaveBeenCalledWith(SwarmCommands.getReview, {
        reviewId: '1001',
        force: true,
      })
      expect(commands.executeCommand).toHaveBeenCalledWith(SwarmCommands.listComments, {
        reviewId: '1001',
        force: true,
      })

      unmount()
      commands.executeCommand.mockClear()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000)
      })
      expect(commands.executeCommand).not.toHaveBeenCalled()
    } finally {
      describeVersion.dispose()
      listComments.dispose()
      getReview.dispose()
    }
  })

  it('keeps a selected version when a refresh discovers a newer version', async () => {
    let detailLoads = 0
    const getReview = registerCommand(SwarmCommands.getReview, () =>
      ++detailLoads === 1 ? DETAIL : DETAIL_WITH_NEW_VERSION,
    )
    const listComments = registerCommand(SwarmCommands.listComments, () => [])
    const describeVersion = registerCommand(SwarmCommands.describeVersion, () => FILES)
    renderReview()
    try {
      await act(async () => Promise.resolve())
      const versionSelect = screen.getAllByRole('combobox')[1] as HTMLSelectElement
      expect(versionSelect.value).toBe('1')

      fireEvent.click(screen.getByRole('button', { name: 'Refresh review' }))
      await act(async () => Promise.resolve())

      expect(versionSelect.value).toBe('1')
      expect(screen.getByRole('option', { name: 'v2 (2002)' })).toBeTruthy()
    } finally {
      describeVersion.dispose()
      listComments.dispose()
      getReview.dispose()
    }
  })

  it('keeps existing files when a background file refresh fails', async () => {
    let fileLoads = 0
    const getReview = registerCommand(SwarmCommands.getReview, () => DETAIL)
    const listComments = registerCommand(SwarmCommands.listComments, () => [])
    const describeVersion = registerCommand(SwarmCommands.describeVersion, () => {
      if (++fileLoads === 1) return FILES
      throw new Error('temporary p4 failure')
    })
    renderReview()
    try {
      await act(async () => Promise.resolve())
      expect(screen.getByText('a.ts')).toBeTruthy()

      fireEvent.click(screen.getByRole('button', { name: 'Refresh review' }))
      await act(async () => Promise.resolve())

      expect(screen.getByText('a.ts')).toBeTruthy()
      expect(screen.queryByText('No files in this version.')).toBeNull()
    } finally {
      describeVersion.dispose()
      listComments.dispose()
      getReview.dispose()
    }
  })
})

describe('SwarmReviewFiles list/tree mode', () => {
  it('shows directory context inline in list mode', () => {
    render(<SwarmReviewFiles files={FILES} viewMode="list" onOpenFile={() => {}} />)

    expect(screen.queryByTestId('swarm-review-file-folder')).toBeNull()
    expect(screen.getByText('a.ts')).toBeTruthy()
    expect(screen.getByText('src/editor')).toBeTruthy()
  })

  it('reuses the compact changed-file tree and supports collapsing folders', () => {
    render(<SwarmReviewFiles files={FILES} viewMode="tree" onOpenFile={() => {}} />)

    expect(screen.getByText('src')).toBeTruthy()
    expect(screen.getByText('editor')).toBeTruthy()
    expect(screen.getByText('runtime')).toBeTruthy()
    fireEvent.click(screen.getByText('editor'))
    expect(screen.queryByText('a.ts')).toBeNull()
    expect(screen.getByText('b.ts')).toBeTruthy()
  })

  it('opens files by click and keyboard and exposes the two view-mode controls', () => {
    const onOpenFile = vi.fn()
    const onViewModeChange = vi.fn()
    render(
      <SwarmReviewFiles
        files={FILES}
        viewMode="list"
        onViewModeChange={onViewModeChange}
        onOpenFile={onOpenFile}
      />,
    )

    fireEvent.click(screen.getByText('a.ts'))
    expect(onOpenFile).toHaveBeenCalledWith(FILES[0])
    fireEvent.keyDown(screen.getByRole('tree'), { key: 'Enter' })
    expect(onOpenFile).toHaveBeenCalledTimes(2)

    fireEvent.click(screen.getByRole('button', { name: 'View as Tree' }))
    expect(onViewModeChange).toHaveBeenCalledWith('tree')
  })
})
