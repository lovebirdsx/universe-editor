/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Swarm review restore + changed-file list/tree regressions.
 *--------------------------------------------------------------------------------------------*/

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  Emitter,
  ICommandService,
  IConfigurationService,
  IDialogService,
  IEditorService,
  ILoggerService,
  INotificationService,
  IOpenerService,
  IStorageService,
  IUriIdentityService,
  IWorkspaceService,
  InstantiationService,
  NullLogger,
  ServiceCollection,
  Severity,
  UriIdentityService,
  URI,
  observableValue,
  type ICommand,
  type IConfigurationChangeEvent,
  type IConfirmOptions,
  type IConfirmResult,
  type IEditorInput,
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
import { swarmApplyStore } from '../../../services/swarm/swarmApplyStore.js'
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

const FILES_WITH_LARGE_CSV: SwarmReviewFileDto[] = [
  {
    status: 'M',
    path: 'tables/big.csv',
    depotFile: '//depot/tables/big.csv',
    baseRevision: '3',
    localPath: 'C:/workspace/tables/big.csv',
  },
]

const FILES_WITH_LARGE_XLSX: SwarmReviewFileDto[] = [
  {
    status: 'M',
    path: 'tables/huge.xlsx',
    depotFile: '//depot/tables/huge.xlsx',
    baseRevision: '3',
    localPath: 'C:/workspace/tables/huge.xlsx',
  },
]

// 2M base64 chars ≈ 1.5MB decoded — past the 1MB spreadsheet webview-diff cap.
const OVERSIZED_BASE64 = 'A'.repeat(2 * 1024 * 1024)

const FILES_WITH_OUTSIDE: SwarmReviewFileDto[] = [
  ...FILES,
  {
    status: 'M',
    path: 'external/c.ts',
    depotFile: '//other/external/c.ts',
    baseRevision: '2',
    localPath: 'D:/outside/external/c.ts',
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

function renderReview(configValues: Record<string, unknown> = {}) {
  const services = new ServiceCollection()
  const commands = new RegistryCommandService()
  services.set(ICommandService, commands as unknown as ICommandService)
  const configChange = new Emitter<IConfigurationChangeEvent>()
  services.set(IConfigurationService, {
    _serviceBrand: undefined,
    get: (key: string) =>
      key === 'perforce.swarm.url' ? 'https://swarm.example.com///' : configValues[key],
    onDidChangeConfiguration: configChange.event,
  } as unknown as IConfigurationService)
  const dialog = {
    _serviceBrand: undefined,
    confirm: vi.fn(
      async (_opts: IConfirmOptions): Promise<IConfirmResult> => ({
        confirmed: false,
        choice: 'cancel' as const,
      }),
    ),
  }
  services.set(IDialogService, dialog as unknown as IDialogService)
  const openEditorsValue = observableValue<readonly IEditorInput[]>('test.openEditors', [])
  const editorService = {
    _serviceBrand: undefined,
    // Mimic EditorService: open dedupes by id within the active group and
    // openEditors mirrors what is open there (the reopen shortcut reads it).
    openEditor: vi.fn((input: IEditorInput) => {
      if (!openEditorsValue.get().some((e) => e.id === input.id)) {
        openEditorsValue.set([...openEditorsValue.get(), input], undefined)
      }
    }),
    openEditors: openEditorsValue,
    closeEditor: vi.fn(),
  }
  services.set(IEditorService, editorService as unknown as IEditorService)
  services.set(ILoggerService, {
    _serviceBrand: undefined,
    createLogger: () => new NullLogger(),
  } as unknown as ILoggerService)
  const notifications = {
    _serviceBrand: undefined,
    notify: vi.fn(),
  }
  services.set(INotificationService, notifications as unknown as INotificationService)
  const opener = {
    _serviceBrand: undefined,
    open: vi.fn(async () => true),
  }
  services.set(IOpenerService, opener as unknown as IOpenerService)
  const storage = new FakeStorage()
  services.set(IStorageService, storage as unknown as IStorageService)
  services.set(IUriIdentityService, new UriIdentityService('win32'))
  services.set(IWorkspaceService, {
    _serviceBrand: undefined,
    current: { folder: URI.file('C:/workspace') },
  } as unknown as IWorkspaceService)
  const instantiation = new InstantiationService(services)
  const input = new SwarmReviewEditorInput('1001')
  const result = render(
    <ServicesContext.Provider value={instantiation}>
      <SwarmReviewEditor input={input} />
    </ServicesContext.Provider>,
  )
  return { ...result, commands, dialog, editorService, input, notifications, opener, configChange }
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
  // Module singleton: restore the defaults for the next test (attach in the
  // apply flow is idempotent, only the values can leak).
  swarmApplyStore.setIncludeOutside(false)
  swarmApplyStore.setIntoChangelist(true)
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
    dialog.confirm.mockResolvedValueOnce({ confirmed: true, choice: 'primary' as const })
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
          ? { content: 'export const a = 1\n' }
          : { content: 'export const a = 2\n' },
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
      expect(diffInput.getName()).toBe('a.ts (base ↔ v1 (2001))')
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
    const getFileContent = registerCommand(SwarmCommands.getFileContent, () => ({
      content: 'CORRUPTED',
    }))
    const getFileContentBytes = registerCommand(
      SwarmCommands.getFileContentBytes,
      (_accessor, request: unknown) =>
        (request as { revision: string }).revision === '#3'
          ? { content: Buffer.from('LEFT-BYTES').toString('base64') }
          : { content: Buffer.from('RIGHT-BYTES').toString('base64') },
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

  it('falls back to the Monaco text diff for an oversized csv instead of the webview', async () => {
    const getReview = registerCommand(SwarmCommands.getReview, () => DETAIL)
    const describeVersion = registerCommand(
      SwarmCommands.describeVersion,
      () => FILES_WITH_LARGE_CSV,
    )
    // Both sides decode past the 1MB cap — the Excel viewer's whole-table LCS
    // would OOM the extension host, so a csv degrades to the plain text diff.
    const leftText = `LEFT-LINE\n${'x'.repeat(2 * 1024 * 1024)}`
    const rightText = `RIGHT-LINE\n${'y'.repeat(2 * 1024 * 1024)}`
    const getFileContentBytes = registerCommand(
      SwarmCommands.getFileContentBytes,
      (_accessor, request: unknown) =>
        (request as { revision: string }).revision === '#3'
          ? { content: Buffer.from(leftText).toString('base64') }
          : { content: Buffer.from(rightText).toString('base64') },
    )
    // The byte probe already holds the full payload: the text fallback must reuse
    // it, not print both sides a second time via getFileContent.
    const getFileContent = registerCommand(SwarmCommands.getFileContent, () => ({
      content: 'SHOULD-NOT-BE-FETCHED',
    }))
    const { commands, editorService } = renderReview()
    try {
      await act(async () => Promise.resolve())
      fireEvent.click(screen.getByText('big.csv'))
      await act(async () => Promise.resolve())

      expect(
        commands.executeCommand.mock.calls.some(([id]) => id === '_workbench.openWebviewDiff'),
      ).toBe(false)
      expect(commands.executeCommand).not.toHaveBeenCalledWith(
        SwarmCommands.getFileContent,
        expect.anything(),
      )
      const diffInput = editorService.openEditor.mock.calls[0]?.[0] as SwarmDiffEditorInput
      expect(diffInput).toBeInstanceOf(SwarmDiffEditorInput)
      expect(diffInput.originalContent).toBe(leftText)
      expect(diffInput.modifiedContent).toBe(rightText)
    } finally {
      getFileContent.dispose()
      getFileContentBytes.dispose()
      describeVersion.dispose()
      getReview.dispose()
    }
  })

  it('shows the error page when the byte probe fails, never routing anywhere', async () => {
    const getReview = registerCommand(SwarmCommands.getReview, () => DETAIL)
    const describeVersion = registerCommand(
      SwarmCommands.describeVersion,
      () => FILES_WITH_SPREADSHEET,
    )
    // A failed p4 print comes back as empty bytes + a structured error. Feeding
    // the empty payload to the size-based routing would read as a 0-byte file and
    // misroute to the Excel webview — the error must short-circuit everything.
    const getFileContentBytes = registerCommand(SwarmCommands.getFileContentBytes, () => ({
      content: '',
      error: 'p4 print failed (exit 1)',
    }))
    const getFileContent = registerCommand(SwarmCommands.getFileContent, () => ({
      content: 'SHOULD-NOT-BE-FETCHED',
    }))
    const { commands, editorService } = renderReview()
    try {
      await act(async () => Promise.resolve())
      fireEvent.click(screen.getByText('buff.xlsx'))
      await act(async () => Promise.resolve())

      expect(
        commands.executeCommand.mock.calls.some(([id]) => id === '_workbench.openWebviewDiff'),
      ).toBe(false)
      expect(commands.executeCommand).not.toHaveBeenCalledWith(
        SwarmCommands.getFileContent,
        expect.anything(),
      )
      expect(editorService.openEditor).not.toHaveBeenCalled()
      expect(screen.getByText('p4 print failed (exit 1)')).toBeTruthy()
    } finally {
      getFileContent.dispose()
      getFileContentBytes.dispose()
      describeVersion.dispose()
      getReview.dispose()
    }
  })

  it('shows the error page when a text-side fetch fails instead of opening an empty diff', async () => {
    const getReview = registerCommand(SwarmCommands.getReview, () => DETAIL)
    const describeVersion = registerCommand(SwarmCommands.describeVersion, () => FILES)
    const getFileContent = registerCommand(
      SwarmCommands.getFileContent,
      (_accessor, request: unknown) =>
        (request as { revision: string }).revision === '#1'
          ? { content: '', error: 'p4 print failed (exit 1)' }
          : { content: 'export const a = 2\n' },
    )
    const { editorService } = renderReview()
    try {
      await act(async () => Promise.resolve())
      fireEvent.click(screen.getByText('a.ts'))
      await act(async () => Promise.resolve())

      expect(editorService.openEditor).not.toHaveBeenCalled()
      expect(screen.getByText('p4 print failed (exit 1)')).toBeTruthy()
    } finally {
      getFileContent.dispose()
      describeVersion.dispose()
      getReview.dispose()
    }
  })

  it('warns and opens nothing for an oversized binary workbook', async () => {
    const getReview = registerCommand(SwarmCommands.getReview, () => DETAIL)
    const describeVersion = registerCommand(
      SwarmCommands.describeVersion,
      () => FILES_WITH_LARGE_XLSX,
    )
    const getFileContentBytes = registerCommand(SwarmCommands.getFileContentBytes, () => ({
      content: OVERSIZED_BASE64,
    }))
    // A binary workbook past the cap has no readable fallback: the utf8 text
    // print must stay untouched and no editor opens.
    const getFileContent = registerCommand(SwarmCommands.getFileContent, () => ({
      content: 'CORRUPTED',
    }))
    const { commands, editorService, notifications } = renderReview()
    try {
      await act(async () => Promise.resolve())
      fireEvent.click(screen.getByText('huge.xlsx'))
      await act(async () => Promise.resolve())

      expect(notifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          severity: Severity.Warning,
          message: expect.stringContaining('too large to compare as a table'),
        }),
      )
      expect(
        commands.executeCommand.mock.calls.some(([id]) => id === '_workbench.openWebviewDiff'),
      ).toBe(false)
      expect(commands.executeCommand).not.toHaveBeenCalledWith(
        SwarmCommands.getFileContent,
        expect.anything(),
      )
      expect(editorService.openEditor).not.toHaveBeenCalled()
    } finally {
      getFileContent.dispose()
      getFileContentBytes.dispose()
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
          ? { content: 'export const a = 1\n' }
          : { content: 'export const a = 2\n' },
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
        immutable: true,
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

  it('does not auto-refresh when perforce.swarm.autoRefresh.enabled is false', async () => {
    const getReview = registerCommand(SwarmCommands.getReview, () => DETAIL)
    const listComments = registerCommand(SwarmCommands.listComments, () => [])
    const describeVersion = registerCommand(SwarmCommands.describeVersion, () => FILES)
    const { commands } = renderReview({ 'perforce.swarm.autoRefresh.enabled': false })
    try {
      await act(async () => Promise.resolve())
      commands.executeCommand.mockClear()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3 * 60_000)
      })
      expect(commands.executeCommand).not.toHaveBeenCalled()

      // Manual refresh is unaffected by the switch.
      fireEvent.click(screen.getByRole('button', { name: 'Refresh review' }))
      await act(async () => Promise.resolve())
      expect(commands.executeCommand).toHaveBeenCalledWith(SwarmCommands.getReview, {
        reviewId: '1001',
        force: true,
      })
    } finally {
      describeVersion.dispose()
      listComments.dispose()
      getReview.dispose()
    }
  })

  it('stops auto-refreshing when the switch is turned off mid-session', async () => {
    const getReview = registerCommand(SwarmCommands.getReview, () => DETAIL)
    const listComments = registerCommand(SwarmCommands.listComments, () => [])
    const describeVersion = registerCommand(SwarmCommands.describeVersion, () => FILES)
    const configValues: Record<string, unknown> = {}
    const { commands, configChange } = renderReview(configValues)
    try {
      await act(async () => Promise.resolve())
      commands.executeCommand.mockClear()

      // Enabled by default: the minute tick refreshes.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000)
      })
      expect(commands.executeCommand).toHaveBeenCalledWith(SwarmCommands.getReview, {
        reviewId: '1001',
        force: true,
      })

      configValues['perforce.swarm.autoRefresh.enabled'] = false
      await act(async () => {
        configChange.fire({
          affectsConfiguration: (k) => k === 'perforce.swarm.autoRefresh.enabled',
        })
      })
      commands.executeCommand.mockClear()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3 * 60_000)
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
      // Selector values are version INDEXES, not rev numbers (pending re-shelves
      // of an unapproved review share one rev, so only the index is unique).
      const versionSelect = screen.getAllByRole('combobox')[1] as HTMLSelectElement
      expect(versionSelect.value).toBe('0')

      fireEvent.click(screen.getByRole('button', { name: 'Refresh review' }))
      await act(async () => Promise.resolve())

      expect(versionSelect.value).toBe('0')
      // The compare (left) and selected (right) selectors both list it.
      expect(screen.getAllByRole('option', { name: 'v2 (2002)' })).toHaveLength(2)
    } finally {
      describeVersion.dispose()
      listComments.dispose()
      getReview.dispose()
    }
  })

  it('defaults to the newest pending version and switches between same-rev versions', async () => {
    // Regression: three pending versions all reporting rev 1 (Swarm only bumps
    // the rev on approve). Keying on `version` collapses them into the first
    // entry — the selector showed v1 (910) forever and switching was a no-op.
    const multiDetail: SwarmReviewDetailDto = {
      ...DETAIL,
      versions: [
        { version: 1, change: '910', pending: true, time: 1 },
        { version: 1, change: '911', pending: true, time: 2 },
        { version: 1, change: '912', pending: true, time: 3 },
      ],
    }
    const getReview = registerCommand(SwarmCommands.getReview, () => multiDetail)
    const listComments = registerCommand(SwarmCommands.listComments, () => [])
    const described: string[] = []
    const describeVersion = registerCommand(SwarmCommands.describeVersion, (_a, req: unknown) => {
      described.push((req as { change: string }).change)
      return FILES
    })
    renderReview()
    try {
      await act(async () => Promise.resolve())

      // Newest pending shelf (912) is the default, not the first-recorded one.
      const versionSelect = screen.getAllByRole('combobox')[1] as HTMLSelectElement
      expect(versionSelect.value).toBe('2')
      expect((versionSelect.selectedOptions[0] as HTMLOptionElement).text).toBe('v1 (912)')
      expect(described).toEqual(['912'])

      // Switching the selector actually re-resolves the file list's change.
      fireEvent.change(versionSelect, { target: { value: '1' } })
      await act(async () => Promise.resolve())
      expect(versionSelect.value).toBe('1')
      expect(described).toEqual(['912', '911'])
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

  it('reopens an already-open immutable diff without re-fetching content', async () => {
    const getReview = registerCommand(SwarmCommands.getReview, () => DETAIL_WITH_ARCHIVE)
    const describeVersion = registerCommand(SwarmCommands.describeVersion, () => FILES)
    const listComments = registerCommand(SwarmCommands.listComments, () => [])
    let contentFetches = 0
    const getFileContent = registerCommand(SwarmCommands.getFileContent, () => {
      contentFetches++
      return { content: 'export const a = 1\n' }
    })
    const { editorService } = renderReview()
    try {
      await act(async () => Promise.resolve())

      fireEvent.click(screen.getByText('a.ts'))
      await act(async () => Promise.resolve())
      // First open: both sides fetched (#1 left, @=2999 right).
      expect(contentFetches).toBe(2)
      const firstInput = editorService.openEditor.mock.calls[0]?.[0] as SwarmDiffEditorInput
      expect(firstInput).toBeInstanceOf(SwarmDiffEditorInput)

      // Second click on the same file: the diff is immutable, so the live tab is
      // simply re-activated — zero p4 traffic, and the very same input instance.
      fireEvent.click(screen.getByText('a.ts'))
      await act(async () => Promise.resolve())
      expect(contentFetches).toBe(2)
      expect(editorService.openEditor).toHaveBeenCalledTimes(2)
      expect(editorService.openEditor.mock.calls[1]?.[0]).toBe(firstInput)
    } finally {
      getFileContent.dispose()
      listComments.dispose()
      describeVersion.dispose()
      getReview.dispose()
    }
  })

  it('refetches a pending (re-shelvable) diff on every click — no reopen shortcut', async () => {
    const getReview = registerCommand(SwarmCommands.getReview, () => DETAIL)
    const describeVersion = registerCommand(SwarmCommands.describeVersion, () => FILES)
    const listComments = registerCommand(SwarmCommands.listComments, () => [])
    let contentFetches = 0
    const getFileContent = registerCommand(SwarmCommands.getFileContent, () => {
      contentFetches++
      return { content: 'export const a = 1\n' }
    })
    const { commands, editorService } = renderReview()
    try {
      await act(async () => Promise.resolve())

      fireEvent.click(screen.getByText('a.ts'))
      await act(async () => Promise.resolve())
      expect(contentFetches).toBe(2)
      // No immutable flag travels with a pending shelf's `@=` request.
      expect(commands.executeCommand).toHaveBeenCalledWith(SwarmCommands.getFileContent, {
        depotFile: '//depot/src/editor/a.ts',
        revision: '@=2001',
      })

      fireEvent.click(screen.getByText('a.ts'))
      await act(async () => Promise.resolve())
      // A pending shelf can be re-shelved: the second click refetches both sides.
      expect(contentFetches).toBe(4)
      expect(editorService.openEditor).toHaveBeenCalledTimes(2)
    } finally {
      getFileContent.dispose()
      listComments.dispose()
      describeVersion.dispose()
      getReview.dispose()
    }
  })
})

describe('SwarmReviewEditor apply to local', () => {
  it('asks with a checkbox, then unshelves only the in-workspace files', async () => {
    const getReview = registerCommand(SwarmCommands.getReview, () => DETAIL)
    const describeVersion = registerCommand(SwarmCommands.describeVersion, () => FILES_WITH_OUTSIDE)
    const applyToLocal = registerCommand(SwarmCommands.applyToLocal, () => ({
      applied: ['//depot/src/editor/a.ts', '//depot/src/runtime/b.ts'],
      skipped: [],
    }))
    const { commands, dialog, notifications } = renderReview()
    dialog.confirm.mockResolvedValueOnce({
      confirmed: true,
      choice: 'primary' as const,
      checkboxChecked: [false, true],
    })
    try {
      await act(async () => Promise.resolve())
      expect(screen.getByText('a.ts')).toBeTruthy()

      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Apply to Local' })))

      // The dialog warns about the replacing semantics and offers the toggles.
      const confirmOpts = dialog.confirm.mock.calls[0]?.[0]
      expect(confirmOpts?.type).toBe('warning')
      expect(confirmOpts?.message).toBe('Apply review #1001 to local files?')
      expect(confirmOpts?.checkboxes?.[0]?.label).toBe('Also replace files outside the workspace')
      expect(confirmOpts?.checkboxes?.[0]?.initiallyChecked).toBe(false)
      expect(confirmOpts?.checkboxes?.[1]?.label).toBe(
        'Open applied files in the default changelist',
      )
      expect(confirmOpts?.checkboxes?.[1]?.initiallyChecked).toBe(true)
      expect(confirmOpts?.detail).toContain('external/c.ts')

      // Outside toggle off → the outside file stays out of the unshelve
      // request, and the archive/immutable change is used (versions[0].change
      // here).
      expect(commands.executeCommand).toHaveBeenCalledWith(SwarmCommands.applyToLocal, {
        change: '2001',
        depotFiles: ['//depot/src/editor/a.ts', '//depot/src/runtime/b.ts'],
        intoChangelist: true,
      })
      expect(swarmApplyStore.includeOutside).toBe(false)
      expect(notifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Applied 2 file(s) to the workspace.' }),
      )
    } finally {
      applyToLocal.dispose()
      describeVersion.dispose()
      getReview.dispose()
    }
  })

  it('includes outside files when the checkbox is checked and persists the toggle', async () => {
    const getReview = registerCommand(SwarmCommands.getReview, () => DETAIL)
    const describeVersion = registerCommand(SwarmCommands.describeVersion, () => FILES_WITH_OUTSIDE)
    const applyToLocal = registerCommand(SwarmCommands.applyToLocal, () => ({
      applied: ['//depot/src/editor/a.ts', '//depot/src/runtime/b.ts', '//other/external/c.ts'],
      skipped: [],
    }))
    const { commands, dialog } = renderReview()
    dialog.confirm.mockResolvedValueOnce({
      confirmed: true,
      choice: 'primary' as const,
      checkboxChecked: [true, true],
    })
    try {
      await act(async () => Promise.resolve())
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Apply to Local' })))

      expect(commands.executeCommand).toHaveBeenCalledWith(SwarmCommands.applyToLocal, {
        change: '2001',
        depotFiles: [
          '//depot/src/editor/a.ts',
          '//depot/src/runtime/b.ts',
          '//other/external/c.ts',
        ],
        intoChangelist: true,
      })
      expect(swarmApplyStore.includeOutside).toBe(true)
    } finally {
      applyToLocal.dispose()
      describeVersion.dispose()
      getReview.dispose()
    }
  })

  it('warns with the skipped files the host reports', async () => {
    const getReview = registerCommand(SwarmCommands.getReview, () => DETAIL)
    const describeVersion = registerCommand(SwarmCommands.describeVersion, () => FILES)
    const applyToLocal = registerCommand(SwarmCommands.applyToLocal, () => ({
      applied: ['//depot/src/editor/a.ts'],
      skipped: [{ depotFile: '//depot/src/runtime/b.ts', reason: 'already opened for edit' }],
    }))
    const { dialog, notifications } = renderReview()
    dialog.confirm.mockResolvedValueOnce({
      confirmed: true,
      choice: 'primary' as const,
      checkboxChecked: [false, true],
    })
    try {
      await act(async () => Promise.resolve())
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Apply to Local' })))

      expect(notifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          severity: 1,
          message: expect.stringContaining('//depot/src/runtime/b.ts — already opened for edit'),
        }),
      )
    } finally {
      applyToLocal.dispose()
      describeVersion.dispose()
      getReview.dispose()
    }
  })

  it('passes intoChangelist false when the changelist checkbox is off and persists it', async () => {
    const getReview = registerCommand(SwarmCommands.getReview, () => DETAIL)
    const describeVersion = registerCommand(SwarmCommands.describeVersion, () => FILES)
    const applyToLocal = registerCommand(SwarmCommands.applyToLocal, () => ({
      applied: ['//depot/src/editor/a.ts', '//depot/src/runtime/b.ts'],
      skipped: [],
      keptOpen: [],
    }))
    const { commands, dialog, notifications } = renderReview()
    dialog.confirm.mockResolvedValueOnce({
      confirmed: true,
      choice: 'primary' as const,
      checkboxChecked: [false, false],
    })
    try {
      await act(async () => Promise.resolve())
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Apply to Local' })))

      expect(commands.executeCommand).toHaveBeenCalledWith(SwarmCommands.applyToLocal, {
        change: '2001',
        depotFiles: ['//depot/src/editor/a.ts', '//depot/src/runtime/b.ts'],
        intoChangelist: false,
      })
      expect(swarmApplyStore.intoChangelist).toBe(false)
      expect(notifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Applied 2 file(s) to the workspace (not opened in a changelist).',
        }),
      )
    } finally {
      applyToLocal.dispose()
      describeVersion.dispose()
      getReview.dispose()
    }
  })

  it('warns about files the host could not un-open (keptOpen)', async () => {
    const getReview = registerCommand(SwarmCommands.getReview, () => DETAIL)
    const describeVersion = registerCommand(SwarmCommands.describeVersion, () => FILES)
    const applyToLocal = registerCommand(SwarmCommands.applyToLocal, () => ({
      applied: ['//depot/src/editor/a.ts', '//depot/src/runtime/b.ts'],
      skipped: [],
      keptOpen: [{ depotFile: '//depot/src/runtime/b.ts', reason: 'file(s) not opened' }],
    }))
    const { dialog, notifications } = renderReview()
    dialog.confirm.mockResolvedValueOnce({
      confirmed: true,
      choice: 'primary' as const,
      checkboxChecked: [false, false],
    })
    try {
      await act(async () => Promise.resolve())
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Apply to Local' })))

      expect(notifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          severity: 1,
          message: expect.stringContaining('//depot/src/runtime/b.ts — file(s) not opened'),
        }),
      )
    } finally {
      applyToLocal.dispose()
      describeVersion.dispose()
      getReview.dispose()
    }
  })

  it('notifies and skips the command when no mapped file is in the workspace', async () => {
    const unmapped: SwarmReviewFileDto[] = [
      {
        status: 'M',
        path: 'src/x.ts',
        depotFile: '//other/src/x.ts',
        baseRevision: '1',
        localPath: null,
      },
    ]
    const getReview = registerCommand(SwarmCommands.getReview, () => DETAIL)
    const describeVersion = registerCommand(SwarmCommands.describeVersion, () => unmapped)
    const applyToLocal = registerCommand(SwarmCommands.applyToLocal, () => ({
      applied: [],
      skipped: [],
    }))
    const { commands, dialog, notifications } = renderReview()
    try {
      await act(async () => Promise.resolve())
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Apply to Local' })))

      expect(commands.executeCommand).not.toHaveBeenCalledWith(
        SwarmCommands.applyToLocal,
        expect.anything(),
      )
      expect(dialog.confirm).not.toHaveBeenCalled()
      expect(notifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('different stream/branch'),
        }),
      )
    } finally {
      applyToLocal.dispose()
      describeVersion.dispose()
      getReview.dispose()
    }
  })

  it('does not list the unmapped paths in the mismatch notice', async () => {
    const foreign: SwarmReviewFileDto[] = [
      {
        status: 'M',
        path: 'aki/branch_3.7/PosTransfer.ts',
        depotFile: '//aki/branch_3.7/Source/Client/TypeScript/PosTransfer.ts',
        baseRevision: '1',
        localPath: null,
      },
    ]
    const getReview = registerCommand(SwarmCommands.getReview, () => DETAIL)
    const describeVersion = registerCommand(SwarmCommands.describeVersion, () => foreign)
    const applyToLocal = registerCommand(SwarmCommands.applyToLocal, () => ({
      applied: [],
      skipped: [],
    }))
    const { commands, dialog, notifications } = renderReview()
    try {
      await act(async () => Promise.resolve())
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Apply to Local' })))

      expect(commands.executeCommand).not.toHaveBeenCalledWith(
        SwarmCommands.applyToLocal,
        expect.anything(),
      )
      expect(dialog.confirm).not.toHaveBeenCalled()
      const message = notifications.notify.mock.calls[0]?.[0]?.message as string
      expect(message).toContain('different stream/branch')
      expect(message).not.toContain('PosTransfer')
    } finally {
      applyToLocal.dispose()
      describeVersion.dispose()
      getReview.dispose()
    }
  })

  it('does nothing when the confirmation is cancelled', async () => {
    const getReview = registerCommand(SwarmCommands.getReview, () => DETAIL)
    const describeVersion = registerCommand(SwarmCommands.describeVersion, () => FILES)
    const applyToLocal = registerCommand(SwarmCommands.applyToLocal, () => ({
      applied: [],
      skipped: [],
    }))
    const { commands } = renderReview()
    try {
      await act(async () => Promise.resolve())
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Apply to Local' })))

      expect(commands.executeCommand).not.toHaveBeenCalledWith(
        SwarmCommands.applyToLocal,
        expect.anything(),
      )
    } finally {
      applyToLocal.dispose()
      describeVersion.dispose()
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
