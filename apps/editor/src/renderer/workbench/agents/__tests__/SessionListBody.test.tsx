/*---------------------------------------------------------------------------------------------
 *  Tests for SessionListBody — archive / pin behavior in the AGENTS session
 *  list: the visibility gate, pinned-first / archived-last ordering, pure-fuzzy
 *  search order, the Del / Shift+Del row keys, the inline buttons, and the
 *  context-menu items. Command dispatch is asserted on ICommandService; list
 *  state changes go through the real history + filter services so the
 *  observable re-render path is exercised end to end.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  Emitter,
  Event,
  InstantiationService,
  ServiceCollection,
  LogLevel,
  NoopTelemetryService,
  NullLogger,
  StorageScope,
  URI,
  UriIdentityService,
  observableValue,
  ICommandService,
  IConfigurationService,
  IDialogService,
  IEditorService,
  IStorageService,
  IUriIdentityService,
  IWorkspaceService,
  type ILogger,
  type ILoggerService,
  type IStorageService as IStorageServiceType,
  type IWorkspace as IWorkspaceType,
  type IWorkspaceService as IWorkspaceServiceType,
} from '@universe-editor/platform'
import {
  IAcpSessionService,
  type IAcpSession,
  type IAcpSessionService as IAcpSessionServiceType,
} from '../../../services/acp/session/acpSessionService.js'
import {
  AcpSessionHistoryService,
  IAcpSessionHistoryService,
  type AcpSessionHistoryEntry,
} from '../../../services/acp/session/acpSessionHistory.js'
import {
  AcpSessionFilterService,
  IAcpSessionFilterService,
} from '../../../services/acp/session/acpSessionFilterService.js'
import {
  IAcpAgentRegistry,
  type IAcpAgentRegistry as IAcpAgentRegistryType,
} from '../../../services/acp/acpAgentRegistry.js'
import { SessionListBody } from '../SessionListBody.js'
import { ServicesContext } from '../../useService.js'

afterEach(() => cleanup())

class FakeStorage implements IStorageServiceType {
  declare readonly _serviceBrand: undefined
  readonly buckets = new Map<StorageScope, Map<string, unknown>>([
    [StorageScope.GLOBAL, new Map()],
    [StorageScope.WORKSPACE, new Map()],
  ])
  private readonly _onDidChangeWorkspaceScope = new Emitter<void>()
  readonly onDidChangeWorkspaceScope = this._onDidChangeWorkspaceScope.event
  async get<T = unknown>(
    key: string,
    scope: StorageScope = StorageScope.GLOBAL,
  ): Promise<T | undefined> {
    return this.buckets.get(scope)?.get(key) as T | undefined
  }
  async set(key: string, value: unknown, scope: StorageScope = StorageScope.GLOBAL): Promise<void> {
    this.buckets.get(scope)!.set(key, value)
  }
  async remove(key: string, scope: StorageScope = StorageScope.GLOBAL): Promise<void> {
    this.buckets.get(scope)!.delete(key)
  }
}

class StubLoggerService implements ILoggerService {
  declare readonly _serviceBrand: undefined
  createLogger(): ILogger {
    return new NullLogger()
  }
  setLevel(): void {}
  getLevel(): LogLevel {
    return LogLevel.Info
  }
}

function makeSessionService(): IAcpSessionServiceType {
  const sessions = observableValue<readonly IAcpSession[]>('test.sessions', [])
  const activeSessionId = observableValue<string | undefined>('test.activeId', undefined)
  const activeSession = observableValue<IAcpSession | undefined>('test.active', undefined)
  return {
    _serviceBrand: undefined,
    sessions,
    activeSessionId,
    activeSession,
    onDidCloseSession: Event.None,
    createSession: (() => Promise.reject(new Error('not implemented'))) as never,
    resumeSession: vi.fn().mockRejectedValue(new Error('not implemented')) as never,
    resumeSessionReadOnly: (() => Promise.reject(new Error('not implemented'))) as never,
    setActive(): void {},
    async closeSession(): Promise<void> {},
    getById: () => undefined,
    async tryRestoreActiveSession(): Promise<void> {},
    requestHydrateIfNeeded(): void {},
    async refreshSessions(): Promise<void> {},
    async deleteOnAgent(): Promise<'ok' | 'unsupported' | 'unknown' | 'error'> {
      return 'unsupported'
    },
    renameSession(): boolean {
      return false
    },
    forkSession: (() => Promise.reject(new Error('not implemented'))) as never,
    forkSideTask: (() => Promise.reject(new Error('not implemented'))) as never,
    rewindSession: (() => Promise.resolve(undefined)) as never,
    mcpServerDefinitions: observableValue('test.mcpDefs', []),
    async refreshMcpServerDefinitions(): Promise<void> {},
    setSessionMcpServers(): void {},
    async readProjectMcpJson(): Promise<Record<string, unknown>> {
      return {}
    },
  } as unknown as IAcpSessionServiceType
}

interface Harness {
  history: AcpSessionHistoryService
  filterService: AcpSessionFilterService
  executeCommand: ReturnType<typeof vi.fn>
  dispose: () => void
}

async function makeHarness(): Promise<Harness> {
  const storage = new FakeStorage()
  const uriIdentity = new UriIdentityService('linux')
  const workspace = {
    _serviceBrand: undefined,
    current: { folder: URI.file('/work'), name: 'ws' } as IWorkspaceType,
  } as unknown as IWorkspaceServiceType
  const history = new AcpSessionHistoryService(
    storage,
    workspace as never,
    new NoopTelemetryService(),
    new StubLoggerService(),
    uriIdentity,
  )
  await history.initialize()
  const filterService = new AcpSessionFilterService(
    storage,
    new NoopTelemetryService(),
    new StubLoggerService(),
  )
  const executeCommand = vi.fn().mockResolvedValue(undefined)

  const services = new ServiceCollection()
  services.set(IAcpSessionService, makeSessionService())
  services.set(IAcpSessionHistoryService, history)
  services.set(IAcpSessionFilterService, filterService)
  services.set(IAcpAgentRegistry, {
    get: () => ({ icon: 'bot' }),
  } as unknown as IAcpAgentRegistryType)
  services.set(IConfigurationService, {
    _serviceBrand: undefined,
    get: () => undefined,
    update: vi.fn(),
    onDidChangeConfiguration: Event.None,
  } as unknown as IConfigurationService)
  services.set(IWorkspaceService, workspace)
  services.set(IUriIdentityService, uriIdentity)
  services.set(IDialogService, {
    _serviceBrand: undefined,
    confirm: vi.fn(),
  } as unknown as IDialogService)
  services.set(IEditorService, {
    _serviceBrand: undefined,
    openEditor: vi.fn(),
  } as unknown as IEditorService)
  services.set(ICommandService, {
    _serviceBrand: undefined,
    executeCommand,
  } as unknown as ICommandService)
  services.set(IStorageService, storage)

  const inst = new InstantiationService(services)
  render(
    <ServicesContext.Provider value={inst}>
      <SessionListBody />
    </ServicesContext.Provider>,
  )
  return {
    history,
    filterService,
    executeCommand,
    dispose: () => {
      history.dispose()
      filterService.dispose()
    },
  }
}

function addEntry(
  history: AcpSessionHistoryService,
  sessionId: string,
  title: string,
  lastUsedAt: number,
  agentId = 'fake',
  cwd: string | undefined = '/work',
  extra: Partial<Pick<AcpSessionHistoryEntry, 'sideTaskOf' | 'sideTaskQuote'>> = {},
): AcpSessionHistoryEntry {
  let entry!: AcpSessionHistoryEntry
  // Flush the entries-observable update synchronously so the row exists by the
  // time the caller asserts on it.
  act(() => {
    const added = history.add({
      agentId,
      sessionIdOnAgent: sessionId,
      title,
      ...(cwd !== undefined ? { cwd } : {}),
      ...extra,
    })
    history.updateInfo(added.id, { updatedAt: lastUsedAt })
    entry = history.get(added.id)!
  })
  return entry
}

function rowOrder(): string[] {
  return [...document.querySelectorAll<HTMLLIElement>('li[data-testid^="session-row-"]')].map(
    (el) => el.dataset['testid']!.replace('session-row-', ''),
  )
}

describe('SessionListBody — archive / pin', () => {
  let harness: Harness
  beforeEach(async () => {
    harness = await makeHarness()
  })
  afterEach(() => {
    harness.dispose()
  })

  it('hides archived rows by default and sinks them to the bottom when shown', async () => {
    const { history, filterService } = harness
    addEntry(history, 'a', 'alpha', 1000)
    addEntry(history, 'b', 'bravo', 2000)
    addEntry(history, 'c', 'charlie', 3000)
    act(() => {
      history.setHistoryArchived('b', true)
    })
    expect(rowOrder()).toEqual(['c', 'a'])
    await act(async () => {
      filterService.toggleArchived()
    })
    expect(rowOrder()).toEqual(['c', 'a', 'b'])
    expect(screen.getByTestId('session-row-b').dataset['archived']).toBe('true')
  })

  it('sorts pinned rows first, then the rest by lastUsedAt', () => {
    const { history } = harness
    addEntry(history, 'a', 'alpha', 1000)
    addEntry(history, 'b', 'bravo', 2000)
    addEntry(history, 'c', 'charlie', 3000)
    act(() => {
      history.setHistoryPinned('a', true)
    })
    expect(rowOrder()).toEqual(['a', 'c', 'b'])
  })

  it('keeps pure fuzzy order while searching — pinned does not outrank a better match', async () => {
    const { history, filterService } = harness
    // x is pinned but only matches the query through its agentId (score 0);
    // y matches its title (score 10000+). Fuzzy order must win over the pin.
    addEntry(history, 'x', 'zzz', 1000, 'needle-agent')
    addEntry(history, 'y', 'needle', 2000)
    act(() => {
      history.setHistoryPinned('x', true)
    })
    expect(rowOrder()[0]).toBe('x')
    await act(async () => {
      filterService.openSearch()
      filterService.setQuery('needle')
    })
    expect(rowOrder()).toEqual(['y', 'x'])
  })

  it('Delete archives the focused row; Shift+Delete is a no-op on an unarchived row', () => {
    const { history, executeCommand } = harness
    addEntry(history, 'a', 'alpha', 1000)
    fireEvent.keyDown(screen.getByTestId('session-row-a'), { key: 'Delete' })
    expect(executeCommand).toHaveBeenCalledWith('workbench.action.agent.archiveSession', {
      sessionId: 'a',
    })
    fireEvent.keyDown(screen.getByTestId('session-row-a'), { key: 'Delete', shiftKey: true })
    expect(executeCommand).toHaveBeenCalledTimes(1)
  })

  it('Shift+Delete unarchives an archived row; plain Delete is a no-op on it', async () => {
    const { history, filterService, executeCommand } = harness
    addEntry(history, 'b', 'bravo', 1000)
    act(() => {
      history.setHistoryArchived('b', true)
    })
    await act(async () => {
      filterService.toggleArchived()
    })
    const row = screen.getByTestId('session-row-b')
    fireEvent.keyDown(row, { key: 'Delete' })
    expect(executeCommand).not.toHaveBeenCalled()
    fireEvent.keyDown(row, { key: 'Delete', shiftKey: true })
    expect(executeCommand).toHaveBeenCalledWith('workbench.action.agent.unarchiveSession', {
      sessionId: 'b',
    })
  })

  it('inline archive/pin buttons dispatch the toggle commands without activating the row', () => {
    const { history, executeCommand } = harness
    addEntry(history, 'a', 'alpha', 1000)
    fireEvent.click(screen.getByRole('button', { name: 'Archive session (Del)' }))
    expect(executeCommand).toHaveBeenCalledWith('workbench.action.agent.archiveSession', {
      sessionId: 'a',
    })
    fireEvent.click(screen.getByRole('button', { name: 'Pin session' }))
    expect(executeCommand).toHaveBeenCalledWith('workbench.action.agent.pinSession', {
      sessionId: 'a',
    })
    // stopPropagation: the row click (resumeSession) must not fire.
    expect(harness.history.get('a')).toBeDefined()
    expect(executeCommand).toHaveBeenCalledTimes(2)
  })

  it('archived / pinned rows flip the inline button labels', async () => {
    const { history, filterService, executeCommand } = harness
    addEntry(history, 'a', 'alpha', 1000)
    addEntry(history, 'b', 'bravo', 2000)
    act(() => {
      history.setHistoryArchived('a', true)
      history.setHistoryPinned('b', true)
    })
    await act(async () => {
      filterService.toggleArchived()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Unarchive session (Shift+Del)' }))
    expect(executeCommand).toHaveBeenCalledWith('workbench.action.agent.unarchiveSession', {
      sessionId: 'a',
    })
    fireEvent.click(screen.getByRole('button', { name: 'Unpin session' }))
    expect(executeCommand).toHaveBeenCalledWith('workbench.action.agent.unpinSession', {
      sessionId: 'b',
    })
  })

  it('context menu offers Pin/Archive with state-dependent labels', async () => {
    const { history, filterService, executeCommand } = harness
    addEntry(history, 'a', 'alpha', 1000)
    addEntry(history, 'b', 'bravo', 2000)
    act(() => {
      history.setHistoryPinned('b', true)
      history.setHistoryArchived('a', true)
    })
    await act(async () => {
      filterService.toggleArchived()
    })
    fireEvent.contextMenu(screen.getByTestId('session-row-b'))
    expect(screen.getByText('Unpin Session')).toBeTruthy()
    expect(screen.getByText('Archive Session')).toBeTruthy()
    fireEvent.click(screen.getByText('Archive Session'))
    expect(executeCommand).toHaveBeenCalledWith('workbench.action.agent.archiveSession', {
      sessionId: 'b',
    })
  })

  it('foreign-worktree rows keep the archive/pin buttons (rename stays hidden)', () => {
    const { history } = harness
    addEntry(history, 'f', 'foreign', 1000, 'fake', '/other')
    const row = screen.getByTestId('session-row-f')
    expect(row.dataset['foreign']).toBe('true')
    expect(screen.getByRole('button', { name: 'Archive session (Del)' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Pin session' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Rename session' })).toBeNull()
  })

  it('never lists side-task rows, not even under the Archived toggle', async () => {
    const { history, filterService } = harness
    addEntry(history, 'a', 'alpha', 1000)
    // Side tasks belong to their parent session and are reached through the
    // parent chat's side-tasks popover, so the list must hide them outright.
    addEntry(history, 'side-1', 'side one', 2000, 'fake', '/work', { sideTaskOf: 'a' })
    addEntry(history, 'side-2', 'side two', 3000, 'fake', '/work', { sideTaskOf: 'a' })
    expect(rowOrder()).toEqual(['a'])

    await act(async () => {
      filterService.toggleArchived()
    })
    expect(rowOrder()).toEqual(['a'])
  })
})
