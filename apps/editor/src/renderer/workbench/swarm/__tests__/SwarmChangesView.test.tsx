/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SwarmChangesView — the sidebar file list that follows the review focused in
 *  the Swarm Reviews tree. Guards the "latest version, archive shelf" contract
 *  and the preview/pin open semantics.
 *--------------------------------------------------------------------------------------------*/

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  DisposableStore,
  ICommandService,
  IEditorService,
  IFileService,
  ILoggerService,
  INotificationService,
  IStorageService,
  IUriIdentityService,
  IWorkspaceService,
  InstantiationService,
  NullLogger,
  ServiceCollection,
  URI,
  observableValue,
  type IEditorInput,
  type IOpenEditorServiceOptions,
} from '@universe-editor/platform'
import {
  SwarmCommands,
  type SwarmReviewDetailDto,
  type SwarmReviewFileDto,
} from '@universe-editor/extensions-common'
import { ServicesContext } from '../../useService.js'
import {
  swarmReviewDetailCache,
  notifyReviewMutated,
} from '../../../services/swarm/swarmViewState.js'
import { swarmChangesViewState } from '../swarmChangesViewState.js'
import { SwarmChangesView } from '../SwarmChangesView.js'

// v2 carries an archive shelf; the view must diff against THAT change, never the
// re-shelvable pending changelist ('2002') and never the rev number.
const DETAIL: SwarmReviewDetailDto = {
  id: '1001',
  state: 'needsReview',
  stateLabel: 'Needs Review',
  author: 'testuser',
  description: 'Two versions',
  updated: 1,
  versions: [
    { version: 1, change: '2001', archiveChange: '2998', pending: false, time: 1 },
    { version: 2, change: '2002', archiveChange: '2999', pending: true, time: 2 },
  ],
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
    depotFile: '//depot/branch_x/src/editor/a.ts',
    baseRevision: '3',
    localPath: 'X:/p4ws/main/src/editor/a.ts',
  },
  {
    status: 'A',
    path: 'src/runtime/b.ts',
    depotFile: '//depot/branch_x/src/runtime/b.ts',
    baseRevision: null,
    localPath: 'X:/p4ws/main/src/runtime/b.ts',
  },
]

function renderView(executeCommand: ReturnType<typeof vi.fn>) {
  const services = new ServiceCollection()
  services.set(ICommandService, { _serviceBrand: undefined, executeCommand } as never)
  const openEditorsValue = observableValue<readonly IEditorInput[]>('test.openEditors', [])
  const openEditor = vi.fn((input: IEditorInput, _options?: IOpenEditorServiceOptions) => {
    if (!openEditorsValue.get().some((e) => e.id === input.id)) {
      openEditorsValue.set([...openEditorsValue.get(), input], undefined)
    }
  })
  services.set(IEditorService, {
    _serviceBrand: undefined,
    openEditor,
    openEditors: openEditorsValue,
    closeEditor: vi.fn(),
  } as never)
  services.set(ILoggerService, {
    _serviceBrand: undefined,
    createLogger: () => new NullLogger(),
  } as never)
  services.set(INotificationService, { _serviceBrand: undefined, notify: vi.fn() } as never)
  services.set(IStorageService, {
    _serviceBrand: undefined,
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  } as never)
  services.set(IUriIdentityService, {
    _serviceBrand: undefined,
    extUri: { isEqual: (a: URI, b: URI) => a.toString() === b.toString() },
  } as never)
  services.set(IFileService, {
    _serviceBrand: undefined,
    onDidFilesChange: () => ({ dispose: () => {} }),
    readFile: vi.fn(),
  } as never)
  services.set(IWorkspaceService, {
    _serviceBrand: undefined,
    current: { folder: URI.file('X:/p4ws/main') },
  } as never)
  const result = render(
    <ServicesContext.Provider value={new InstantiationService(services)}>
      <SwarmChangesView />
    </ServicesContext.Provider>,
  )
  return { ...result, openEditor }
}

/** The view gates each fetch on waitForSwarmCommand, which reads the global
 *  CommandsRegistry — register no-op stubs so it does not sit in its retry loop. */
function registerSwarmCommandStubs(store: DisposableStore): void {
  for (const id of [
    SwarmCommands.getReview,
    SwarmCommands.describeVersion,
    SwarmCommands.getFileContent,
  ]) {
    store.add(CommandsRegistry.registerCommand({ id, handler: () => undefined }))
  }
}

function fakeSwarmCommands(overrides: Record<string, unknown> = {}) {
  return vi.fn(async (command: string) => {
    if (command in overrides) return overrides[command]
    if (command === SwarmCommands.getReview) return DETAIL
    if (command === SwarmCommands.describeVersion) return FILES
    if (command === SwarmCommands.getFileContent) return { content: 'text' }
    return undefined
  })
}

let commandStubs: DisposableStore

beforeEach(() => {
  swarmChangesViewState._resetForTests()
  swarmReviewDetailCache.clear()
  commandStubs = new DisposableStore()
  registerSwarmCommandStubs(commandStubs)
})

afterEach(() => {
  cleanup()
  commandStubs.dispose()
  swarmChangesViewState._resetForTests()
  swarmReviewDetailCache.clear()
  vi.restoreAllMocks()
})

describe('SwarmChangesView', () => {
  it('shows a placeholder until a review is selected', () => {
    renderView(fakeSwarmCommands())
    expect(screen.getByTestId('swarm-changes-empty').textContent).toContain('Select a review')
  })

  it("lists the latest version's files, resolved through its archive shelf", async () => {
    const executeCommand = fakeSwarmCommands()
    renderView(executeCommand)

    swarmChangesViewState.select('1001')

    expect(await screen.findByText('a.ts')).toBeTruthy()
    expect(screen.getByText('b.ts')).toBeTruthy()
    expect(executeCommand).toHaveBeenCalledWith(SwarmCommands.getReview, { reviewId: '1001' })
    // The last version's archiveChange — not '2002' (re-shelvable) and not rev 2.
    expect(executeCommand).toHaveBeenCalledWith(SwarmCommands.describeVersion, {
      change: '2999',
      immutable: true,
    })
  })

  it('paints from the detail cache without re-fetching the review', async () => {
    swarmReviewDetailCache.set('1001', DETAIL)
    const executeCommand = fakeSwarmCommands()
    renderView(executeCommand)

    swarmChangesViewState.select('1001')

    expect(await screen.findByText('a.ts')).toBeTruthy()
    expect(executeCommand).not.toHaveBeenCalledWith(SwarmCommands.getReview, expect.anything())
  })

  it('opens a diff previewed on single click and pinned on double click', async () => {
    const { openEditor } = renderView(fakeSwarmCommands())
    swarmChangesViewState.select('1001')

    const row = (await screen.findAllByTestId('swarm-changes-row'))[0]!
    fireEvent.click(row)
    await waitFor(() => expect(openEditor).toHaveBeenCalled())
    expect(openEditor.mock.calls[0]?.[1]).toEqual({ pinned: false, preserveFocus: true })

    openEditor.mockClear()
    fireEvent.doubleClick(row)
    await waitFor(() => expect(openEditor).toHaveBeenCalled())
    expect(openEditor.mock.calls.at(-1)?.[1]).toEqual({ pinned: true })
  })

  it('re-fetches when the selected review mutates', async () => {
    const executeCommand = fakeSwarmCommands()
    renderView(executeCommand)
    swarmChangesViewState.select('1001')
    await screen.findByText('a.ts')

    const describeCalls = () =>
      executeCommand.mock.calls.filter((c) => c[0] === SwarmCommands.describeVersion).length
    const before = describeCalls()

    notifyReviewMutated('1001')
    await waitFor(() => expect(describeCalls()).toBeGreaterThan(before))
    // The archive shelf is immutable, so a forced refresh must not ask the host
    // to bypass its cache for it.
    expect(executeCommand).not.toHaveBeenCalledWith(
      SwarmCommands.describeVersion,
      expect.objectContaining({ force: true }),
    )
  })

  it('reports a review with no versions as having no changed files', async () => {
    const executeCommand = fakeSwarmCommands({
      [SwarmCommands.getReview]: { ...DETAIL, versions: [] },
    })
    renderView(executeCommand)
    swarmChangesViewState.select('1001')

    expect(await screen.findByTestId('swarm-changes-empty')).toBeTruthy()
    expect(executeCommand).not.toHaveBeenCalledWith(
      SwarmCommands.describeVersion,
      expect.anything(),
    )
  })
})
