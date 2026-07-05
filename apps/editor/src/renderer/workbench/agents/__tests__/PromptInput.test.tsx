/*---------------------------------------------------------------------------------------------
 *  Tests for PromptInput's slash-command keyboard wiring + send/cancel
 *  behaviour. The session is a tiny stub backed by real observableValue
 *  instances so useObservable inside the component reacts to changes.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react'
import type { GitGraphCommitDto, GitGraphLoadResult } from '@universe-editor/extensions-common'
import { GitGraphCommands } from '@universe-editor/extensions-common'
import {
  Emitter,
  Event,
  ICommandService,
  IConfigurationService,
  IContextKeyService,
  ContextKeyService,
  IDialogService,
  IEditorGroupsService,
  IEditorService,
  IFileDialogService,
  IFileSearchService,
  IFileService,
  IHostService,
  INotificationService,
  InstantiationService,
  IQuickInputService,
  IUriIdentityService,
  IWorkspaceService,
  observableValue,
  ServiceCollection,
  URI,
} from '@universe-editor/platform'
import type {
  ICommandService as ICommandServiceType,
  IConfigurationService as IConfigurationServiceType,
  IDialogService as IDialogServiceType,
  IEditorGroupsService as IEditorGroupsServiceType,
  IEditorService as IEditorServiceType,
  IFileDialogService as IFileDialogServiceType,
  IFileSearchService as IFileSearchServiceType,
  IFileService as IFileServiceType,
  IHostService as IHostServiceType,
  INotificationService as INotificationServiceType,
  IQuickInputService as IQuickInputServiceType,
  IQuickPickItem,
  ISettableObservable,
  IUriIdentityService as IUriIdentityServiceType,
  IWorkspace,
  IWorkspaceService as IWorkspaceServiceType,
} from '@universe-editor/platform'
import { IDocsService } from '../../../../shared/ipc/docsService.js'
import type { IDocsService as IDocsServiceType } from '../../../../shared/ipc/docsService.js'
import { ILanguageFeaturesService } from '../../../services/languageFeatures/LanguageFeaturesService.js'
import type { ILanguageFeaturesService as ILanguageFeaturesServiceType } from '../../../services/languageFeatures/LanguageFeaturesService.js'
import { IScmService } from '../../../services/extensions/ScmService.js'
import type { IScmService as IScmServiceType } from '../../../services/extensions/ScmService.js'
import type {
  AcpMessage,
  AcpPendingPermission,
  AcpPendingQuestion,
  AcpPlanEntry,
  AcpSessionStatus,
  AcpToolCall,
  AcpUsage,
  IAcpSession,
  TimelineItem,
} from '../../../services/acp/acpSessionService.js'
import type { AvailableCommand, SessionConfigOption } from '@agentclientprotocol/sdk'
import { invalidateMentionFileCache } from '../../../services/acp/mentionFileSearch.js'
import { AcpPromptDraftCache } from '../../../services/acp/acpPromptDraftCache.js'
import { PromptInput, extractSlashQuery } from '../PromptInput.js'
import type { WidgetHandle } from '../ChatBody.js'
import { ServicesContext } from '../../useService.js'
import { IExcludeService } from '../../../services/exclude/ExcludeService.js'
import { FakeExcludeService } from '../../../services/exclude/testing/fakeExcludeService.js'
import { IAcpPromptHistoryService } from '../../../services/acp/acpPromptHistoryService.js'
import { MonacoLoader } from '../../editor/monaco/MonacoLoader.js'

// Preload Monaco once so <PromptMonacoEditor> mounts its (stubbed) editor
// synchronously — the wrapper mounts sync when MonacoLoader.peek() is warm, so
// tests can query `acp-prompt-input` right after render like the old textarea.
beforeAll(async () => {
  await MonacoLoader.ensureInitialized()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  notifySpy.mockClear()
  showOpenDialogSpy.mockClear()
  readClipboardImageSpy.mockClear()
  nextClipboardImage = null
  nextPick = undefined
  invalidateMentionFileCache()
  AcpPromptDraftCache._resetForTests()
  stubHistoryEntries.set([], undefined)
})

const stubFileSearch: IFileSearchServiceType = {
  _serviceBrand: undefined,
  async search() {
    return {
      results: [],
      limitHit: false,
      filesWalked: 0,
      directoriesWalked: 0,
      durationMs: 0,
    }
  },
} as IFileSearchServiceType

const stubWorkspaceService: IWorkspaceServiceType = {
  _serviceBrand: undefined,
  current: null,
  onDidChangeWorkspace: Event.None,
  recent: [],
  onDidChangeRecent: Event.None,
  async openFolder() {},
  async closeFolder() {},
  async clearRecent() {},
  async removeRecent() {},
} as unknown as IWorkspaceServiceType

// Returns 0 (disabled) for the confirm-length key so no confirmation dialog
// fires in tests; image limits get sane defaults so paste tests can attach.
const stubConfigurationService: IConfigurationServiceType = {
  _serviceBrand: undefined,
  get: ((key: string) => {
    if (key === 'acp.prompt.image.maxSizeMB') return 5
    if (key === 'acp.prompt.image.maxCount') return 5
    return 0
  }) as never,
  onDidChangeConfiguration: Event.None,
  update: () => Promise.resolve(),
  keys: () => [],
  inspect: () => ({ value: 0 }) as never,
} as unknown as IConfigurationServiceType

const stubDialogService: IDialogServiceType = {
  _serviceBrand: undefined,
  confirm: () => Promise.resolve({ confirmed: true, choice: 'primary' as const }),
  prompt: () => Promise.resolve(undefined),
} as unknown as IDialogServiceType

const stubHistoryEntries = observableValue<readonly string[]>('test.history', [])
const stubHistoryService: IAcpPromptHistoryService = {
  _serviceBrand: undefined,
  entries: stubHistoryEntries,
  push: () => {},
}

const notifySpy = vi.fn()
const stubNotificationService: INotificationServiceType = {
  _serviceBrand: undefined,
  notify: notifySpy,
} as unknown as INotificationServiceType

const stubFileService: IFileServiceType = {
  _serviceBrand: undefined,
  readFile: async () => new Uint8Array([1, 2, 3, 4]),
} as unknown as IFileServiceType

// Host stub: readClipboardImage backs the EditContext paste fallback (the
// renderer's sync ClipboardEvent hides image bytes, so the image is read from
// the main process). `nextClipboardImage` is what it resolves with, set per test.
let nextClipboardImage: { dataBase64: string; mimeType: string; byteSize: number } | null = null
const readClipboardImageSpy = vi.fn(() => Promise.resolve(nextClipboardImage))
const stubHostService: IHostServiceType = {
  _serviceBrand: undefined,
  readClipboardImage: readClipboardImageSpy,
} as unknown as IHostServiceType

// File dialog stub: `nextPick` is what showOpenDialog resolves with (set per
// test); showOpenDialogSpy records the options it was called with.
let nextPick: URI | undefined
const showOpenDialogSpy = vi.fn()
const stubFileDialogService: IFileDialogServiceType = {
  _serviceBrand: undefined,
  showOpenDialog: (opts: unknown) => {
    showOpenDialogSpy(opts)
    return Promise.resolve(nextPick)
  },
  showSaveDialog: () => Promise.resolve(undefined),
} as unknown as IFileDialogServiceType

// --- # context-popover DI stubs -------------------------------------------
// Minimal shapes for the four ContextSuggestionItem providers' constructor
// dependencies (see contextSuggestions.ts). Correctness of the providers
// themselves is covered by contextSuggestions.test.ts; here we only need
// non-throwing stand-ins so the popover's data-fetching effect can run.

const stubLanguageFeatures: ILanguageFeaturesServiceType = {
  _serviceBrand: undefined,
  getWorkspaceSymbolProviders: () => [],
} as unknown as ILanguageFeaturesServiceType

const stubUriIdentity: IUriIdentityServiceType = {
  _serviceBrand: undefined,
  platform: 'linux',
  isEqual: (a?: URI, b?: URI) => a?.toString() === b?.toString(),
  isEqualOrParent: () => false,
  getComparisonKey: (uri: URI) => uri.toString(),
  arePathsEqual: (a?: string, b?: string) => a === b,
  getPathComparisonKey: (p: string) => p,
  relativePathUnder: (root: string, child: string) => {
    const normRoot = root.replace(/\\/g, '/').replace(/\/$/, '')
    const normChild = child.replace(/\\/g, '/')
    if (normChild === normRoot) return ''
    return normChild.startsWith(normRoot + '/') ? normChild.slice(normRoot.length + 1) : null
  },
  createResourceMap: () => new Map() as never,
  createResourceSet: () => new Set() as never,
} as unknown as IUriIdentityServiceType

const stubEditorGroupsService: IEditorGroupsServiceType = {
  _serviceBrand: undefined,
  groups: [],
} as unknown as IEditorGroupsServiceType

const stubCommandService: ICommandServiceType = {
  _serviceBrand: undefined,
  executeCommand: async () => undefined,
} as unknown as ICommandServiceType

const stubQuickInputServiceDefault: IQuickInputServiceType = {
  _serviceBrand: undefined,
  createQuickPick: () => {
    throw new Error('createQuickPick not stubbed for this test')
  },
} as unknown as IQuickInputServiceType

function makeEditorService(): IEditorServiceType {
  return {
    _serviceBrand: undefined,
    openEditor: () => {},
    openEditors: observableValue('test.openEditors', []),
    activeEditorId: observableValue('test.activeEditorId', undefined),
    activeEditor: observableValue('test.activeEditor', undefined),
  } as unknown as IEditorServiceType
}

function makeScmService(paths: readonly string[]): IScmServiceType {
  const resources = paths.map((p) => ({ resourceUri: p, contextValue: 'M' }))
  const group = { resources: { get: () => resources } }
  const sourceControl = { rootUri: '/repo', groups: { get: () => [group] } }
  return {
    _serviceBrand: undefined,
    sourceControls: { get: () => [sourceControl] },
  } as unknown as IScmServiceType
}

function makeDocsService(root = '/repo/docs'): IDocsServiceType {
  return {
    _serviceBrand: undefined,
    getDocs: async () => ({}),
    getDocsRoot: async () => root,
  } as unknown as IDocsServiceType
}

function makeWorkspaceService(folder: URI): IWorkspaceServiceType {
  const ws: IWorkspace = { folder, name: 'test' }
  return {
    _serviceBrand: undefined,
    current: ws,
    onDidChangeWorkspace: Event.None,
    recent: [],
    onDidChangeRecent: Event.None,
    async openFolder() {},
    async closeFolder() {},
    async clearRecent() {},
  } as unknown as IWorkspaceServiceType
}

function makeFileSearch(paths: readonly string[]): IFileSearchServiceType {
  return {
    _serviceBrand: undefined,
    async search(query) {
      const rootPath = query.root.fsPath.replace(/\\/g, '/').replace(/\/$/, '')
      return {
        results: paths.map((abs) => {
          const norm = abs.replace(/\\/g, '/')
          const rel = norm.startsWith(rootPath + '/')
            ? norm.slice(rootPath.length + 1)
            : norm.startsWith(rootPath)
              ? norm.slice(rootPath.length)
              : norm
          const name = rel.split('/').pop() ?? rel
          return {
            resource: URI.file(abs).toJSON(),
            fsPath: abs,
            relativePath: rel,
            basename: name,
            score: 0,
          }
        }),
        limitHit: false,
        filesWalked: paths.length,
        directoriesWalked: 1,
        durationMs: 0,
      }
    },
  }
}

function makeHandleRef(): { current: WidgetHandle } {
  return {
    current: {
      move: () => {},
      scrollTimeline: () => {},
      focus: () => false,
      jumpToPlan: () => {},
      toggleCollapse: () => {},
      cycleCollapseMode: () => {},
      getFocusedText: () => undefined,
      setFocusedKey: () => {},
      popoverSelectNext: () => {},
      popoverSelectPrev: () => {},
      popoverAccept: () => {},
      popoverHide: () => {},
      openFind: () => {},
      closeFind: () => {},
      findNext: () => {},
      findPrev: () => {},
    },
  }
}

function renderWithServices(
  node: React.ReactNode,
  opts: {
    fileSearch?: IFileSearchServiceType
    workspace?: IWorkspaceServiceType
    scm?: IScmServiceType
    docs?: IDocsServiceType
    editorService?: IEditorServiceType
    contextKeyService?: IContextKeyService
    commands?: ICommandServiceType
    quickInput?: IQuickInputServiceType
  } = {},
) {
  const services = new ServiceCollection()
  services.set(IFileSearchService, opts.fileSearch ?? stubFileSearch)
  services.set(IWorkspaceService, opts.workspace ?? stubWorkspaceService)
  services.set(IExcludeService, new FakeExcludeService())
  services.set(IConfigurationService, stubConfigurationService)
  services.set(IDialogService, stubDialogService)
  services.set(IAcpPromptHistoryService, stubHistoryService)
  services.set(INotificationService, stubNotificationService)
  services.set(IFileService, stubFileService)
  services.set(IHostService, stubHostService)
  services.set(IFileDialogService, stubFileDialogService)
  services.set(ILanguageFeaturesService, stubLanguageFeatures)
  services.set(IUriIdentityService, stubUriIdentity)
  services.set(IEditorGroupsService, stubEditorGroupsService)
  services.set(IScmService, opts.scm ?? makeScmService([]))
  services.set(IDocsService, opts.docs ?? makeDocsService())
  services.set(IEditorService, opts.editorService ?? makeEditorService())
  services.set(IContextKeyService, opts.contextKeyService ?? new ContextKeyService())
  services.set(ICommandService, opts.commands ?? stubCommandService)
  services.set(IQuickInputService, opts.quickInput ?? stubQuickInputServiceDefault)
  const inst = new InstantiationService(services)
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <ServicesContext.Provider value={inst}>{children}</ServicesContext.Provider>
  )
  return render(node, { wrapper: Wrapper })
}

interface FakeSessionOptions {
  readonly id?: string
  readonly status?: AcpSessionStatus
  readonly commands?: readonly AvailableCommand[]
  readonly usage?: AcpUsage
  readonly imageSupported?: boolean
}

interface FakeSession extends IAcpSession {
  readonly sendPrompt: ReturnType<typeof vi.fn> & IAcpSession['sendPrompt']
  readonly cancelTurn: ReturnType<typeof vi.fn> & IAcpSession['cancelTurn']
  readonly statusObs: ISettableObservable<AcpSessionStatus>
  readonly commandsObs: ISettableObservable<readonly AvailableCommand[]>
}

function makeSession(opts: FakeSessionOptions = {}): FakeSession {
  const statusObs = observableValue<AcpSessionStatus>('test.status', opts.status ?? 'idle')
  const commandsObs = observableValue<readonly AvailableCommand[]>(
    'test.commands',
    opts.commands ?? [],
  )
  const messages = observableValue<readonly AcpMessage[]>('test.messages', [])
  const toolCalls = observableValue<readonly AcpToolCall[]>('test.toolCalls', [])
  const plan = observableValue<readonly AcpPlanEntry[]>('test.plan', [])
  const timeline = observableValue<readonly TimelineItem[]>('test.timeline', [])
  const permission = observableValue<AcpPendingPermission | undefined>('test.permission', undefined)
  const configOptions = observableValue<readonly SessionConfigOption[]>('test.configOptions', [])
  const sendPrompt = vi.fn().mockResolvedValue(undefined)
  const cancelTurn = vi.fn().mockResolvedValue(undefined)
  return {
    id: opts.id ?? 's1',
    agentId: 'fake',
    readOnly: false,
    sessionIdOnAgent: observableValue<string | undefined>('test.sessionIdOnAgent', opts.id ?? 's1'),
    title: 'Fake',
    messages,
    toolCalls,
    plan,
    timeline,
    status: statusObs,
    isReplayingHistory: observableValue<boolean>('test.replay', false),
    beginHistoryReplay: () => {},
    endHistoryReplay: () => {},
    usage: observableValue<AcpUsage | undefined>('test.usage', opts.usage),
    pendingPermission: permission,
    pendingQuestion: observableValue<AcpPendingQuestion | undefined>('test.question', undefined),
    configOptions,
    availableCommands: commandsObs,
    mcpServers: observableValue('test.mcpServers', []),
    collapseMode: observableValue('test.collapseMode', 'default' as const),
    accumulatedRunningMs: observableValue('test.arm', 0),
    runningStartedAt: observableValue<number | undefined>('test.rsa', undefined),
    imageSupported: observableValue<boolean>('test.imageSupported', opts.imageSupported ?? false),
    onDidRequireAuth: Event.None,
    presentPermission: () => {},
    presentQuestion: () => {},
    sendPrompt: sendPrompt as never,
    cancelTurn: cancelTurn as never,
    close: () => Promise.resolve(),
    setConfigOption: () => Promise.resolve(),
    renameTitle: () => {},
    cycleCollapseMode: () => {},
    whenConnected: () => Promise.resolve(),
    statusObs,
    commandsObs,
  } satisfies FakeSession
}

const COMMANDS: readonly AvailableCommand[] = [
  { name: 'help', description: 'help' },
  { name: 'diff', description: 'show diff', input: { hint: 'path' } },
  { name: 'clear', description: 'reset' },
]

function getTextarea(): HTMLTextAreaElement {
  return screen.getByTestId('acp-prompt-input') as HTMLTextAreaElement
}

function setPromptHistory(entries: readonly string[]): void {
  act(() => {
    stubHistoryEntries.set(entries, undefined)
  })
}

describe('extractSlashQuery', () => {
  it('returns the substring after the leading slash', () => {
    expect(extractSlashQuery('/diff', 5)).toBe('diff')
    expect(extractSlashQuery('/', 1)).toBe('')
  })

  it('returns null when text does not start with slash', () => {
    expect(extractSlashQuery('hello', 5)).toBeNull()
    expect(extractSlashQuery(' /diff', 6)).toBeNull()
  })

  it('returns null once the caret moves past the command-name token', () => {
    expect(extractSlashQuery('/diff foo', 9)).toBeNull()
    expect(extractSlashQuery('/diff ', 6)).toBeNull()
  })

  it('keeps the command name while the caret stays inside it, even with body text', () => {
    // 已有正文，光标停在开头命令名内 → 仍返回命令名（需求：先写内容再补 `/cmd`）
    expect(extractSlashQuery('/diff review the code', 5)).toBe('diff')
    expect(extractSlashQuery('/di review the code', 3)).toBe('di')
  })
})

describe('PromptInput — slash popover gating', () => {
  it('does not show the popover when there are no commands', () => {
    renderWithServices(<PromptInput session={makeSession()} />)
    fireEvent.change(getTextarea(), { target: { value: '/' } })
    expect(screen.queryByTestId('acp-slash-popover')).toBeNull()
  })

  it('shows the popover when text starts with `/` and commands are available', () => {
    renderWithServices(<PromptInput session={makeSession({ commands: COMMANDS })} />)
    fireEvent.change(getTextarea(), { target: { value: '/' } })
    expect(screen.getByTestId('acp-slash-popover')).toBeTruthy()
    expect(screen.getAllByRole('option')).toHaveLength(3)
  })

  it('filters the popover as the user types after the slash', () => {
    renderWithServices(<PromptInput session={makeSession({ commands: COMMANDS })} />)
    fireEvent.change(getTextarea(), { target: { value: '/di' } })
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(1)
    expect(options[0]?.textContent).toContain('/diff')
  })

  it('hides the popover once the caret leaves the command token', () => {
    renderWithServices(<PromptInput session={makeSession({ commands: COMMANDS })} />)
    const ta = getTextarea()
    fireEvent.change(ta, { target: { value: '/diff' } })
    ta.setSelectionRange(5, 5)
    fireEvent.keyUp(ta, { key: 'f' })
    expect(screen.getByTestId('acp-slash-popover')).toBeTruthy()
    // Type a trailing space and move the caret past it → user is now editing
    // the body, so the popover collapses.
    fireEvent.change(ta, { target: { value: '/diff ' } })
    ta.setSelectionRange(6, 6)
    fireEvent.keyUp(ta, { key: ' ' })
    expect(screen.queryByTestId('acp-slash-popover')).toBeNull()
  })
})

describe('PromptInput — slash popover navigation (via widget handle)', () => {
  // Navigation / accept / hide are no longer hand-rolled in onKeyDown. They are
  // real commands (gated on `acpPromptPopupVisible`) routed to the focused
  // widget, which forwards them to these handle methods. Unit tests drive the
  // handle directly since no global keybinding handler is mounted here.
  function renderWithHandle(commands: readonly AvailableCommand[] = COMMANDS) {
    const handleRef = makeHandleRef()
    const session = makeSession({ commands })
    renderWithServices(<PromptInput session={session} handleRef={handleRef} />)
    const ta = getTextarea()
    fireEvent.change(ta, { target: { value: '/' } })
    return { handleRef, session, ta }
  }

  it('popoverSelectNext advances the active item, wrapping at the end', () => {
    const { handleRef } = renderWithHandle()
    expect(screen.getAllByRole('option')[0]?.getAttribute('aria-selected')).toBe('true')
    act(() => handleRef.current.popoverSelectNext())
    expect(screen.getAllByRole('option')[1]?.getAttribute('aria-selected')).toBe('true')
    act(() => handleRef.current.popoverSelectNext())
    expect(screen.getAllByRole('option')[2]?.getAttribute('aria-selected')).toBe('true')
    act(() => handleRef.current.popoverSelectNext())
    // wraps back to 0
    expect(screen.getAllByRole('option')[0]?.getAttribute('aria-selected')).toBe('true')
  })

  it('popoverSelectPrev moves backwards, wrapping at the start', () => {
    const { handleRef } = renderWithHandle()
    act(() => handleRef.current.popoverSelectPrev())
    expect(screen.getAllByRole('option')[2]?.getAttribute('aria-selected')).toBe('true')
  })

  it('popoverAccept inserts the active command name without submitting', () => {
    const { handleRef, session, ta } = renderWithHandle()
    act(() => handleRef.current.popoverSelectNext()) // move to /diff
    act(() => handleRef.current.popoverAccept())
    expect(ta.value).toBe('/diff ')
    expect(session.sendPrompt).not.toHaveBeenCalled()
    expect(screen.queryByTestId('acp-slash-popover')).toBeNull()
  })

  it('popoverHide dismisses the popover without clearing the input', () => {
    const handleRef = makeHandleRef()
    renderWithServices(
      <PromptInput session={makeSession({ commands: COMMANDS })} handleRef={handleRef} />,
    )
    const ta = getTextarea()
    fireEvent.change(ta, { target: { value: '/d' } })
    expect(screen.getByTestId('acp-slash-popover')).toBeTruthy()
    act(() => handleRef.current.popoverHide())
    expect(screen.queryByTestId('acp-slash-popover')).toBeNull()
    expect(ta.value).toBe('/d')
  })

  it('popoverAccept on `/` prepended to body text replaces only the command token', () => {
    const handleRef = makeHandleRef()
    renderWithServices(
      <PromptInput session={makeSession({ commands: COMMANDS })} handleRef={handleRef} />,
    )
    const ta = getTextarea()
    fireEvent.change(ta, { target: { value: '/di review the code' } })
    ta.setSelectionRange(3, 3) // caret inside `/di`
    fireEvent.keyUp(ta, { key: 'i' })
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(1)
    expect(options[0]?.textContent).toContain('/diff')
    // Accepting replaces only the leading command token, keeping the body.
    act(() => handleRef.current.popoverAccept())
    expect(ta.value).toBe('/diff review the code')
    expect(screen.queryByTestId('acp-slash-popover')).toBeNull()
  })

  it('mouse-clicking a row inserts that command', () => {
    renderWithServices(<PromptInput session={makeSession({ commands: COMMANDS })} />)
    const ta = getTextarea()
    fireEvent.change(ta, { target: { value: '/' } })
    const options = screen.getAllByRole('option')
    fireEvent.mouseDown(options[2]!)
    expect(ta.value).toBe('/clear ')
  })

  it('popoverAccept on a name that already has a leading slash does not double it', () => {
    // 部分 agent 实现会把 `/` 写进 name 字段（schema 推荐不带）。两种形态都要还原成 `/<name> `。
    const prefixed: readonly AvailableCommand[] = [{ name: '/diff', description: 'show diff' }]
    const handleRef = makeHandleRef()
    renderWithServices(
      <PromptInput session={makeSession({ commands: prefixed })} handleRef={handleRef} />,
    )
    const ta = getTextarea()
    fireEvent.change(ta, { target: { value: '/' } })
    act(() => handleRef.current.popoverAccept())
    expect(ta.value).toBe('/diff ')
  })

  it('popover always renders names with a leading slash regardless of fixture form', () => {
    const mixed: readonly AvailableCommand[] = [
      { name: 'help', description: 'h' },
      { name: '/diff', description: 'd' },
    ]
    renderWithServices(<PromptInput session={makeSession({ commands: mixed })} />)
    fireEvent.change(getTextarea(), { target: { value: '/' } })
    const options = screen.getAllByRole('option')
    expect(options[0]?.textContent).toContain('/help')
    expect(options[1]?.textContent).toContain('/diff')
    // 不能出现 //
    expect(options[1]?.textContent).not.toContain('//')
  })

  it('reports popover open/closed via onPopoverOpenChange', () => {
    const changes: boolean[] = []
    renderWithServices(
      <PromptInput
        session={makeSession({ commands: COMMANDS })}
        onPopoverOpenChange={(open) => changes.push(open)}
      />,
    )
    const ta = getTextarea()
    fireEvent.change(ta, { target: { value: '/d' } })
    expect(changes.at(-1)).toBe(true)
    fireEvent.change(ta, { target: { value: 'plain text' } })
    expect(changes.at(-1)).toBe(false)
  })
})

describe('PromptInput — submit and cancel', () => {
  it('Enter (no popover) calls sendPrompt and clears the textarea', () => {
    const session = makeSession()
    renderWithServices(<PromptInput session={session} />)
    const ta = getTextarea()
    fireEvent.change(ta, { target: { value: 'hello world' } })
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(session.sendPrompt).toHaveBeenCalledWith('hello world', [], [], [])
    expect(ta.value).toBe('')
  })

  it('Shift+Enter inserts a newline instead of sending', () => {
    const session = makeSession()
    renderWithServices(<PromptInput session={session} />)
    const ta = getTextarea()
    fireEvent.change(ta, { target: { value: 'hi' } })
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true })
    expect(session.sendPrompt).not.toHaveBeenCalled()
  })

  it('Send button is disabled when the text is whitespace-only', () => {
    const session = makeSession()
    renderWithServices(<PromptInput session={session} />)
    fireEvent.change(getTextarea(), { target: { value: '   ' } })
    const btn = screen.getByTestId('acp-prompt-send') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })

  it('shows the Stop button alongside Send while the session is running', () => {
    const session = makeSession({ status: 'running' })
    renderWithServices(<PromptInput session={session} />)
    // Send stays available so the user can dispatch a steering message.
    expect(screen.getByTestId('acp-prompt-send')).toBeTruthy()
    const cancel = screen.getByTestId('acp-prompt-cancel')
    fireEvent.click(cancel)
    expect(session.cancelTurn).toHaveBeenCalledTimes(1)
  })

  it('allows sending a new prompt while the session is running (mid-turn steering)', () => {
    const session = makeSession({ status: 'running' })
    renderWithServices(<PromptInput session={session} />)
    const ta = getTextarea()
    fireEvent.change(ta, { target: { value: 'steer left' } })
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(session.sendPrompt).toHaveBeenCalledWith('steer left', [], [], [])
    expect(ta.value).toBe('')
  })

  it('does not submit on Enter while a popover is open', () => {
    // The popover's Accept command (gated on `acpPromptPopupVisible`) owns Enter
    // while open; the textarea bails out so the prompt isn't sent underneath it.
    const session = makeSession({ commands: COMMANDS })
    renderWithServices(<PromptInput session={session} />)
    const ta = getTextarea()
    fireEvent.change(ta, { target: { value: '/d' } })
    expect(screen.getByTestId('acp-slash-popover')).toBeTruthy()
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(session.sendPrompt).not.toHaveBeenCalled()
  })

  it('re-renders when commands arrive after mount', () => {
    const session = makeSession()
    renderWithServices(<PromptInput session={session} />)
    fireEvent.change(getTextarea(), { target: { value: '/' } })
    expect(screen.queryByTestId('acp-slash-popover')).toBeNull()
    act(() => {
      session.commandsObs.set(COMMANDS, undefined)
    })
    expect(screen.getByTestId('acp-slash-popover')).toBeTruthy()
  })
})

describe('PromptInput — history navigation', () => {
  it('opens history when ArrowUp is pressed on the first visual row', () => {
    setPromptHistory(['previous prompt'])
    renderWithServices(<PromptInput session={makeSession()} />)
    const ta = getTextarea()
    fireEvent.change(ta, { target: { value: 'draft' } })
    ta.setSelectionRange(5, 5)

    act(() => {
      fireEvent.keyDown(ta, { key: 'ArrowUp' })
    })

    expect(screen.getByTestId('acp-history-popover')).toBeTruthy()
  })

  it('does not open history when ArrowUp moves up within the buffer (caret below row 1)', () => {
    setPromptHistory(['previous prompt'])
    renderWithServices(<PromptInput session={makeSession()} />)
    const ta = getTextarea()
    // Two logical lines: with the caret on line 2 the editor's top-of-caret sits
    // below the first visual row, so ArrowUp is a cursor move, not history open.
    const text = 'first line\nsecond line'
    fireEvent.change(ta, { target: { value: text } })
    ta.setSelectionRange(text.length, text.length)

    fireEvent.keyDown(ta, { key: 'ArrowUp' })

    expect(screen.queryByTestId('acp-history-popover')).toBeNull()
    expect(ta.value).toBe(text)
  })

  it('keeps the history popover open when a bare cursor move fires after it opens', () => {
    // Regression: real Monaco fires a deferred cursor-position event right after
    // the history-nav setText settles. It arrives as source:'user' (outside the
    // programmatic window) but carries no text edit — treating it as typing used
    // to close the just-opened popover, so the popover flashed and vanished.
    setPromptHistory(['previous prompt'])
    renderWithServices(<PromptInput session={makeSession()} />)
    const ta = getTextarea()
    fireEvent.change(ta, { target: { value: 'draft' } })
    ta.setSelectionRange(5, 5)

    act(() => {
      fireEvent.keyDown(ta, { key: 'ArrowUp' })
    })
    expect(screen.getByTestId('acp-history-popover')).toBeTruthy()

    // A cursor-only event (the stub bridges keyup → onDidChangeCursorPosition,
    // i.e. emitChange('cursor')). It must NOT close the popover.
    act(() => {
      fireEvent.keyUp(ta, { key: 'ArrowUp' })
    })
    expect(screen.getByTestId('acp-history-popover')).toBeTruthy()
  })

  it('renders newest at the bottom (nearest the input) and moves the highlight up on ArrowUp', () => {
    // The popover floats above the input, so the list grows bottom-up: oldest at
    // the top, newest at the bottom. ArrowUp (older) must move the highlight up.
    setPromptHistory(['third', 'second', 'first']) // newest-first
    const handleRef = makeHandleRef()
    renderWithServices(<PromptInput session={makeSession()} handleRef={handleRef} />)
    const ta = getTextarea()
    fireEvent.change(ta, { target: { value: 'draft' } })
    ta.setSelectionRange(5, 5)

    act(() => {
      fireEvent.keyDown(ta, { key: 'ArrowUp' })
    })

    // Display order is oldest→newest, top→bottom.
    let options = screen.getAllByRole('option')
    expect(options.map((o) => o.textContent)).toEqual(['first', 'second', 'third'])
    // Opened on the newest entry → highlight is the bottom row.
    expect(options[2]?.getAttribute('aria-selected')).toBe('true')

    // ArrowUp (older) moves the highlight visually up to the middle row.
    act(() => handleRef.current.popoverSelectPrev())
    options = screen.getAllByRole('option')
    expect(options[1]?.getAttribute('aria-selected')).toBe('true')
    expect(options[2]?.getAttribute('aria-selected')).toBe('false')

    // Once more up → the top (oldest) row.
    act(() => handleRef.current.popoverSelectPrev())
    options = screen.getAllByRole('option')
    expect(options[0]?.getAttribute('aria-selected')).toBe('true')
  })

  it('walks further back through history on repeated ArrowUp (via popoverSelectPrev)', () => {
    // Newest-first, as the history service stores them.
    setPromptHistory(['third', 'second', 'first'])
    const handleRef = makeHandleRef()
    renderWithServices(<PromptInput session={makeSession()} handleRef={handleRef} />)
    const ta = getTextarea()
    fireEvent.change(ta, { target: { value: 'draft' } })
    ta.setSelectionRange(5, 5)

    // First ArrowUp opens the popover on the newest entry.
    act(() => {
      fireEvent.keyDown(ta, { key: 'ArrowUp' })
    })
    expect(screen.getByTestId('acp-history-popover')).toBeTruthy()
    expect(ta.value).toBe('third')

    // Subsequent ArrowUp is routed by the global keybinding (up, gated on
    // acpPromptPopupVisible) to popoverSelectPrev — it must step to older
    // entries, not stay stuck on the first one.
    act(() => handleRef.current.popoverSelectPrev())
    expect(ta.value).toBe('second')
    act(() => handleRef.current.popoverSelectPrev())
    expect(ta.value).toBe('first')
    // Clamp at the oldest: another Up does not wrap back to the newest.
    act(() => handleRef.current.popoverSelectPrev())
    expect(ta.value).toBe('first')
  })

  it('ArrowDown walks back toward newer entries and restores the draft below the newest', () => {
    setPromptHistory(['third', 'second', 'first'])
    const handleRef = makeHandleRef()
    renderWithServices(<PromptInput session={makeSession()} handleRef={handleRef} />)
    const ta = getTextarea()
    fireEvent.change(ta, { target: { value: 'draft' } })
    ta.setSelectionRange(5, 5)

    act(() => {
      fireEvent.keyDown(ta, { key: 'ArrowUp' })
    })
    act(() => handleRef.current.popoverSelectPrev()) // → 'second'
    expect(ta.value).toBe('second')

    // Down (popoverSelectNext) steps back toward newer entries…
    act(() => handleRef.current.popoverSelectNext())
    expect(ta.value).toBe('third')
    // …and stepping below the newest restores the in-progress draft + closes it.
    act(() => handleRef.current.popoverSelectNext())
    expect(ta.value).toBe('draft')
    expect(screen.queryByTestId('acp-history-popover')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// @-mention popover — requires a workspace + file service. Caret is set
// manually because happy-dom doesn't actually move it on `change` events.
// ---------------------------------------------------------------------------

function typeAt(ta: HTMLTextAreaElement, value: string, caret = value.length): void {
  fireEvent.change(ta, { target: { value } })
  // Force a caret position so the mention parser sees an in-progress token.
  ta.setSelectionRange(caret, caret)
  fireEvent.keyUp(ta, { key: 'a' })
}

const FILES = ['/repo/src/main.ts', '/repo/src/index.ts', '/repo/README.md']

describe('PromptInput — @-mention popover', () => {
  it('does not open the popover when there is no workspace', async () => {
    renderWithServices(<PromptInput session={makeSession()} />)
    typeAt(getTextarea(), '@')
    // No workspace → file scan never runs → popover collapses (loading text
    // is not shown because we gate by `mentionQuery !== null` ∧ filesLoading).
    expect(screen.queryByTestId('acp-mention-popover')).toBeNull()
  })

  it('opens the popover and lists workspace files when user types @', async () => {
    renderWithServices(<PromptInput session={makeSession()} />, {
      workspace: makeWorkspaceService(URI.file('/repo')),
      fileSearch: makeFileSearch(FILES),
    })
    const ta = getTextarea()
    typeAt(ta, '@')
    // Loading state first; allow microtasks to flush so the file list lands.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(screen.getByTestId('acp-mention-popover')).toBeTruthy()
    const options = screen.getAllByRole('option')
    expect(options.length).toBeGreaterThanOrEqual(3)
  })

  it('filters the file list as the user keeps typing', async () => {
    renderWithServices(<PromptInput session={makeSession()} />, {
      workspace: makeWorkspaceService(URI.file('/repo')),
      fileSearch: makeFileSearch(FILES),
    })
    const ta = getTextarea()
    typeAt(ta, '@')
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    typeAt(ta, '@main')
    const options = screen.getAllByRole('option')
    expect(options[0]?.textContent).toContain('main.ts')
  })

  it('accepting a mention inserts the relative path and records it for send', async () => {
    const session = makeSession()
    const handleRef = makeHandleRef()
    renderWithServices(<PromptInput session={session} handleRef={handleRef} />, {
      workspace: makeWorkspaceService(URI.file('/repo')),
      fileSearch: makeFileSearch(FILES),
    })
    const ta = getTextarea()
    typeAt(ta, '@')
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    typeAt(ta, '@main')
    act(() => handleRef.current.popoverAccept())
    // The accepted mention is inserted as a tracked pill (display text + space).
    expect(ta.value).toContain('@src/main.ts')
    // The popover collapses (we dismissed it on accept).
    expect(screen.queryByTestId('acp-mention-popover')).toBeNull()
    // Submitting hands the range-tracked ref to sendPrompt as the 2nd arg.
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(session.sendPrompt).toHaveBeenCalledTimes(1)
    const [, refs] = session.sendPrompt.mock.calls[0]!
    expect(refs).toHaveLength(1)
    expect(refs[0].ref).toMatchObject({
      kind: 'file',
      label: 'src/main.ts',
      uri: URI.file('/repo/src/main.ts').toString(),
    })
  })

  it('popoverHide dismisses the mention popover without clearing the text', async () => {
    const handleRef = makeHandleRef()
    renderWithServices(<PromptInput session={makeSession()} handleRef={handleRef} />, {
      workspace: makeWorkspaceService(URI.file('/repo')),
      fileSearch: makeFileSearch(FILES),
    })
    const ta = getTextarea()
    typeAt(ta, '@')
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(screen.getByTestId('acp-mention-popover')).toBeTruthy()
    act(() => handleRef.current.popoverHide())
    expect(screen.queryByTestId('acp-mention-popover')).toBeNull()
    expect(ta.value).toBe('@')
  })

  it('slash popover takes precedence over mention popover while the user is still typing the slash command name', async () => {
    renderWithServices(<PromptInput session={makeSession({ commands: COMMANDS })} />, {
      workspace: makeWorkspaceService(URI.file('/repo')),
      fileSearch: makeFileSearch(FILES),
    })
    const ta = getTextarea()
    // `/diff` has no trailing whitespace yet — slash command is still being
    // composed. Even if there were a literal `@` later, the slash popover
    // owns the buffer because extractSlashQuery() returns non-null.
    typeAt(ta, '/diff')
    expect(screen.getByTestId('acp-slash-popover')).toBeTruthy()
    expect(screen.queryByTestId('acp-mention-popover')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// #-context popover — structural twin of the @-mention block above. Provider
// correctness (fuzzy ranking, normalization, dedup) is already covered by
// contextSuggestions.test.ts; here we only exercise the popover's keyboard
// wiring. makeScmService gives a couple of "local change" rows and the
// default docs stub always yields one "文档" row, which together are enough
// suggestions to drive navigation without touching every provider.
// ---------------------------------------------------------------------------

describe('PromptInput — # context popover', () => {
  async function flush(): Promise<void> {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  }

  it('does not open the popover when there is no workspace', () => {
    renderWithServices(<PromptInput session={makeSession()} />)
    typeAt(getTextarea(), '#')
    expect(screen.queryByTestId('acp-context-popover')).toBeNull()
  })

  it('opens the popover and lists context suggestions when the user types #', async () => {
    renderWithServices(<PromptInput session={makeSession()} />, {
      workspace: makeWorkspaceService(URI.file('/repo')),
      scm: makeScmService(['/repo/src/a.ts', '/repo/src/b.ts']),
    })
    const ta = getTextarea()
    typeAt(ta, '#')
    await flush()
    expect(screen.getByTestId('acp-context-popover')).toBeTruthy()
    // 2 local-change rows + 1 docs row + 1 "Git Commit…" row.
    expect(screen.getAllByRole('option')).toHaveLength(4)
  })

  it('popoverSelectNext/Prev move the active row across groups', async () => {
    const handleRef = makeHandleRef()
    renderWithServices(<PromptInput session={makeSession()} handleRef={handleRef} />, {
      workspace: makeWorkspaceService(URI.file('/repo')),
      scm: makeScmService(['/repo/src/a.ts', '/repo/src/b.ts']),
    })
    const ta = getTextarea()
    typeAt(ta, '#')
    await flush()
    expect(screen.getAllByRole('option')[0]?.getAttribute('aria-selected')).toBe('true')
    act(() => handleRef.current.popoverSelectNext())
    expect(screen.getAllByRole('option')[1]?.getAttribute('aria-selected')).toBe('true')
    act(() => handleRef.current.popoverSelectPrev())
    expect(screen.getAllByRole('option')[0]?.getAttribute('aria-selected')).toBe('true')
  })

  it('accepting a suggestion inserts a #label pill and records a ref for send', async () => {
    const session = makeSession()
    const handleRef = makeHandleRef()
    renderWithServices(<PromptInput session={session} handleRef={handleRef} />, {
      workspace: makeWorkspaceService(URI.file('/repo')),
      scm: makeScmService([]),
      docs: makeDocsService('/repo/docs'),
    })
    const ta = getTextarea()
    typeAt(ta, '#')
    await flush()
    expect(screen.getByTestId('acp-context-popover')).toBeTruthy()
    act(() => handleRef.current.popoverAccept())
    // DocsContextProvider's fixed label — a label WITH SPACES, the whole reason
    // for by-range tracking. Inserted as a pill (display text + trailing space).
    expect(ta.value).toContain('#Editor User Guide')
    expect(screen.queryByTestId('acp-context-popover')).toBeNull()

    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(session.sendPrompt).toHaveBeenCalledTimes(1)
    const [, refs] = session.sendPrompt.mock.calls[0]!
    expect(refs).toHaveLength(1)
    expect(refs[0].ref).toMatchObject({
      kind: 'docs',
      label: 'Editor User Guide',
      uri: URI.file('/repo/docs').toString(),
      meta: { description: expect.any(String) },
    })
  })

  it('orders sources by item count, fewest first (docs above local changes)', async () => {
    renderWithServices(<PromptInput session={makeSession()} />, {
      workspace: makeWorkspaceService(URI.file('/repo')),
      // 2 local-change rows vs the single docs/commit rows — the smaller
      // groups must sort ahead of the larger "local changes" group.
      scm: makeScmService(['/repo/src/a.ts', '/repo/src/b.ts']),
      docs: makeDocsService('/repo/docs'),
    })
    const ta = getTextarea()
    typeAt(ta, '#')
    await flush()
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(4)
    expect(options[0]?.textContent).toContain('Editor User Guide')
  })

  it('popoverHide dismisses the # popover without clearing the text', async () => {
    const handleRef = makeHandleRef()
    renderWithServices(<PromptInput session={makeSession()} handleRef={handleRef} />, {
      workspace: makeWorkspaceService(URI.file('/repo')),
      scm: makeScmService(['/repo/src/a.ts']),
    })
    const ta = getTextarea()
    typeAt(ta, '#')
    await flush()
    expect(screen.getByTestId('acp-context-popover')).toBeTruthy()
    act(() => handleRef.current.popoverHide())
    expect(screen.queryByTestId('acp-context-popover')).toBeNull()
    expect(ta.value).toBe('#')
  })

  it('does not also open the @-mention popover while # is active', async () => {
    renderWithServices(<PromptInput session={makeSession()} />, {
      workspace: makeWorkspaceService(URI.file('/repo')),
      fileSearch: makeFileSearch(FILES),
      scm: makeScmService(['/repo/src/a.ts']),
    })
    const ta = getTextarea()
    typeAt(ta, '#')
    await flush()
    expect(screen.getByTestId('acp-context-popover')).toBeTruthy()
    expect(screen.queryByTestId('acp-mention-popover')).toBeNull()
  })

  it('does not also open the # popover while @ is active', async () => {
    renderWithServices(<PromptInput session={makeSession()} />, {
      workspace: makeWorkspaceService(URI.file('/repo')),
      fileSearch: makeFileSearch(FILES),
      scm: makeScmService(['/repo/src/a.ts']),
    })
    const ta = getTextarea()
    typeAt(ta, '@')
    await flush()
    expect(screen.getByTestId('acp-mention-popover')).toBeTruthy()
    expect(screen.queryByTestId('acp-context-popover')).toBeNull()
  })

  it('slash popover takes precedence over the # popover while composing a slash command', () => {
    renderWithServices(<PromptInput session={makeSession({ commands: COMMANDS })} />, {
      workspace: makeWorkspaceService(URI.file('/repo')),
      scm: makeScmService(['/repo/src/a.ts']),
    })
    const ta = getTextarea()
    typeAt(ta, '/diff')
    expect(screen.getByTestId('acp-slash-popover')).toBeTruthy()
    expect(screen.queryByTestId('acp-context-popover')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// #commit picker flow — selecting the "Git Commit…" entry from the # popover
// hands off to an independent QuickPick (CommitRefPicker) driven by
// ICommandService/IQuickInputService rather than inserting synchronously.
// Provider/picker correctness is covered by contextSuggestions.test.ts and
// commitRefPicker.test.ts; here we only exercise the PromptInput wiring.
// ---------------------------------------------------------------------------

interface FakeQuickPick {
  placeholder: string | undefined
  matchOnDescription: boolean
  matchOnDetail: boolean
  busy: boolean
  items: readonly IQuickPickItem[]
  readonly onDidAccept: Event<IQuickPickItem[]>
  readonly onDidHide: Event<void>
  show(): void
  hide(): void
  dispose(): void
  accept(item: IQuickPickItem): void
}

function makeFakeCommandService(
  handlers: Record<string, (...args: unknown[]) => unknown>,
): ICommandServiceType {
  return {
    _serviceBrand: undefined,
    executeCommand: async (id: string, ...args: unknown[]) => handlers[id]?.(...args),
  } as unknown as ICommandServiceType
}

function makeFakeQuickInput(): {
  service: IQuickInputServiceType
  getPicker: () => FakeQuickPick | undefined
} {
  let current: FakeQuickPick | undefined
  const service = {
    _serviceBrand: undefined,
    createQuickPick: () => {
      const onDidAccept = new Emitter<IQuickPickItem[]>()
      const onDidHide = new Emitter<void>()
      const qp: FakeQuickPick = {
        placeholder: undefined,
        matchOnDescription: false,
        matchOnDetail: false,
        busy: false,
        items: [],
        onDidAccept: onDidAccept.event,
        onDidHide: onDidHide.event,
        show: () => {},
        hide: () => onDidHide.fire(),
        dispose: () => {
          onDidAccept.dispose()
          onDidHide.dispose()
        },
        accept: (item) => onDidAccept.fire([item]),
      }
      current = qp
      return qp
    },
  }
  return { service: service as unknown as IQuickInputServiceType, getPicker: () => current }
}

const COMMIT: GitGraphCommitDto = {
  hash: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
  parents: [],
  author: 'Alice',
  email: 'alice@example.com',
  date: 1700000000,
  message: 'fix login bug',
  heads: [],
  tags: [],
  remotes: [],
  stash: null,
  worktrees: [],
}

describe('PromptInput — # commit picker flow', () => {
  async function flush(): Promise<void> {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  }

  function commandsWithCommit(): ICommandServiceType {
    return makeFakeCommandService({
      [GitGraphCommands.setRepo]: () => undefined,
      [GitGraphCommands.getCommits]: () =>
        ({
          commits: [COMMIT],
          head: null,
          headName: null,
          moreAvailable: false,
          uncommittedChanges: 0,
        }) satisfies GitGraphLoadResult,
    })
  }

  it('selecting the Git Commit entry opens a QuickPick and inserts the picked commit as a pill', async () => {
    const session = makeSession()
    const { service: quickInput, getPicker } = makeFakeQuickInput()
    renderWithServices(<PromptInput session={session} />, {
      workspace: makeWorkspaceService(URI.file('/repo')),
      scm: makeScmService([]),
      commands: commandsWithCommit(),
      quickInput,
    })
    const ta = getTextarea()
    typeAt(ta, '#')
    await flush()
    const option = screen.getAllByRole('option').find((o) => o.textContent?.includes('Git Commit'))
    expect(option).toBeTruthy()

    fireEvent.mouseDown(option!)
    // The "#" token is removed and the popover closes immediately — the
    // QuickPick runs independently while the input stays clean.
    expect(ta.value).toBe('')
    expect(screen.queryByTestId('acp-context-popover')).toBeNull()

    await waitFor(() => expect(getPicker()?.items).toHaveLength(1))
    act(() => getPicker()!.accept(getPicker()!.items[0]!))
    await waitFor(() => expect(ta.value).toContain('#a1b2c3d fix login bug'))

    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(session.sendPrompt).toHaveBeenCalledTimes(1)
    const [, refs] = session.sendPrompt.mock.calls[0]!
    expect(refs).toHaveLength(1)
    expect(refs[0].ref).toMatchObject({
      kind: 'commit',
      label: 'a1b2c3d fix login bug',
      uri: URI.file('/repo').toString(),
      meta: { commitHash: COMMIT.hash, description: COMMIT.message },
    })
  })

  it('dismissing the QuickPick leaves the input clean with no stray ref', async () => {
    const session = makeSession()
    const { service: quickInput, getPicker } = makeFakeQuickInput()
    renderWithServices(<PromptInput session={session} />, {
      workspace: makeWorkspaceService(URI.file('/repo')),
      scm: makeScmService([]),
      commands: commandsWithCommit(),
      quickInput,
    })
    const ta = getTextarea()
    typeAt(ta, '#')
    await flush()
    const option = screen.getAllByRole('option').find((o) => o.textContent?.includes('Git Commit'))
    fireEvent.mouseDown(option!)
    expect(ta.value).toBe('')

    await waitFor(() => expect(getPicker()?.items).toHaveLength(1))
    act(() => getPicker()!.hide())

    fireEvent.change(ta, { target: { value: 'hello' } })
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(session.sendPrompt).toHaveBeenCalledWith('hello', [], [], [])
  })
})

// ---------------------------------------------------------------------------
// File / folder picker triggers — `@@` opens a file picker, `@#` a folder
// picker (SimpleFileDialog). On pick the chosen resource is spliced in as an
// @-mention and recorded so it serializes to a resource_link on send.
// ---------------------------------------------------------------------------

describe('PromptInput — @@ / @# file picker triggers', () => {
  it('opens the file picker on @@ and inserts the pick as a recorded mention', async () => {
    nextPick = URI.file('/repo/src/main.ts')
    const session = makeSession()
    renderWithServices(<PromptInput session={session} />, {
      workspace: makeWorkspaceService(URI.file('/repo')),
    })
    const ta = getTextarea()
    fireEvent.change(ta, { target: { value: '@@', selectionStart: 2 } })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    // File picker was requested (files only, not folders).
    expect(showOpenDialogSpy).toHaveBeenCalledTimes(1)
    const opts = showOpenDialogSpy.mock.calls[0]![0]
    expect(opts.canSelectFiles).toBe(true)
    expect(opts.canSelectFolders).toBe(false)
    // The `@@` trigger is gone; the workspace-relative mention pill is inserted.
    expect(ta.value).toBe('@src/main.ts ')
    // Submitting hands the range-tracked ref to sendPrompt.
    fireEvent.keyDown(ta, { key: 'Enter' })
    const [, refs] = session.sendPrompt.mock.calls[0]!
    expect(refs).toHaveLength(1)
    expect(refs[0].ref).toMatchObject({
      kind: 'file',
      label: 'src/main.ts',
      uri: URI.file('/repo/src/main.ts').toString(),
    })
  })

  it('opens the folder picker on @# with folders selectable', async () => {
    nextPick = URI.file('/repo/levels')
    const session = makeSession()
    renderWithServices(<PromptInput session={session} />, {
      workspace: makeWorkspaceService(URI.file('/repo')),
    })
    const ta = getTextarea()
    fireEvent.change(ta, { target: { value: '@#', selectionStart: 2 } })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    const opts = showOpenDialogSpy.mock.calls[0]![0]
    expect(opts.canSelectFiles).toBe(false)
    expect(opts.canSelectFolders).toBe(true)
    expect(ta.value).toBe('@levels ')
  })

  it('strips the trigger and inserts nothing when the picker is cancelled', async () => {
    nextPick = undefined // cancelled
    const session = makeSession()
    renderWithServices(<PromptInput session={session} />, {
      workspace: makeWorkspaceService(URI.file('/repo')),
    })
    const ta = getTextarea()
    fireEvent.change(ta, { target: { value: 'look @@', selectionStart: 7 } })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(showOpenDialogSpy).toHaveBeenCalledTimes(1)
    // Trigger removed, no mention added, surrounding text preserved.
    expect(ta.value).toBe('look ')
  })

  it('splices the mention at the trigger position, keeping surrounding text', async () => {
    nextPick = URI.file('/repo/a.ts')
    const session = makeSession()
    renderWithServices(<PromptInput session={session} />, {
      workspace: makeWorkspaceService(URI.file('/repo')),
    })
    const ta = getTextarea()
    fireEvent.change(ta, { target: { value: 'see @@ please', selectionStart: 6 } })

    await waitFor(() => expect(ta.value).toBe('see @a.ts please'))
  })
})

// ---------------------------------------------------------------------------
// Focus handoff — Ctrl+Alt+I command (via the AcpChatWidget handle) and the
// auto-focus on session swap. Both must land on the same textarea.
// ---------------------------------------------------------------------------

describe('PromptInput — focus handoff', () => {
  it('exposes focus() on the widget handle to focus the textarea', () => {
    const handleRef = makeHandleRef()
    renderWithServices(<PromptInput session={makeSession()} handleRef={handleRef} />)
    const ta = getTextarea()
    expect(document.activeElement).not.toBe(ta)
    act(() => {
      handleRef.current.focus()
    })
    expect(document.activeElement).toBe(ta)
  })

  it('focuses the textarea when the active session id changes', () => {
    const first = makeSession({ id: 's1' })
    const { rerender } = renderWithServices(<PromptInput session={first} />)
    const ta = getTextarea()
    // Initial mount must NOT auto-focus — we don't want to steal focus from
    // whatever click opened the panel.
    expect(document.activeElement).not.toBe(ta)
    const second = makeSession({ id: 's2' })
    rerender(<PromptInput session={second} />)
    expect(document.activeElement).toBe(ta)
  })

  it('does not refocus when the same session re-renders', () => {
    const session = makeSession()
    const { rerender } = renderWithServices(<PromptInput session={session} />)
    const ta = getTextarea()
    expect(document.activeElement).not.toBe(ta)
    rerender(<PromptInput session={session} />)
    expect(document.activeElement).not.toBe(ta)
  })

  // Regression: the prompt editor (editContext: true, no DOM-editable focus host)
  // must mirror focus onto `editorTextFocus`, or the global keybinding handler
  // treats it as a non-text surface and a global `delete` binding (delete-file)
  // swallows the Delete key — Delete does nothing in the input. See
  // editor-text-focus-stuck-swallows-keys for the mirror-image bug.
  it('sets editorTextFocus while the prompt editor holds focus, clears on blur', () => {
    const contextKeyService = new ContextKeyService()
    renderWithServices(<PromptInput session={makeSession()} />, { contextKeyService })
    const ta = getTextarea()

    expect(contextKeyService.get('editorTextFocus')).not.toBe(true)
    act(() => ta.focus())
    expect(contextKeyService.get('editorTextFocus')).toBe(true)
    act(() => ta.blur())
    expect(contextKeyService.get('editorTextFocus')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Draft persistence — each session keeps its own unsent text via
// AcpPromptDraftCache. ChatBody keys PromptInput by session id, so switching
// sessions remounts the component; the draft is restored from the cache.
// ---------------------------------------------------------------------------

describe('PromptInput — draft persistence', () => {
  it('keeps each session draft isolated in the cache', () => {
    renderWithServices(<PromptInput session={makeSession({ id: 's1' })} />)
    fireEvent.change(getTextarea(), { target: { value: 'draft for one' } })
    expect(AcpPromptDraftCache.load('s1')?.text).toBe('draft for one')
    expect(AcpPromptDraftCache.load('s2')).toBeUndefined()
  })

  it('restores the draft when the same session remounts', () => {
    const session = makeSession({ id: 's1' })
    renderWithServices(<PromptInput session={session} />)
    fireEvent.change(getTextarea(), { target: { value: 'unfinished thought' } })
    cleanup() // simulate switching away (PromptInput unmounts)
    renderWithServices(<PromptInput session={session} />)
    expect(getTextarea().value).toBe('unfinished thought')
  })

  it('restores tracked refs so a remounted draft still sends its references', async () => {
    const session = makeSession({ id: 's1' })
    const opts = {
      workspace: makeWorkspaceService(URI.file('/repo')),
      fileSearch: makeFileSearch(['/repo/src/main.ts']),
    }
    const handleRef = makeHandleRef()
    renderWithServices(<PromptInput session={session} handleRef={handleRef} />, opts)
    const ta = getTextarea()
    typeAt(ta, '@')
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    typeAt(ta, '@main')
    act(() => handleRef.current.popoverAccept()) // accept mention → tracked pill
    expect(ta.value).toContain('@src/main.ts')

    cleanup() // switch away: PromptInput unmounts, draft + ref cached
    renderWithServices(<PromptInput session={session} />, opts)
    const restored = getTextarea()
    expect(restored.value).toContain('@src/main.ts')
    fireEvent.keyDown(restored, { key: 'Enter' }) // submit the restored draft
    expect(session.sendPrompt).toHaveBeenCalledTimes(1)
    const [, refs] = session.sendPrompt.mock.calls[0]!
    expect(refs).toHaveLength(1)
    expect(refs[0].ref).toMatchObject({
      kind: 'file',
      label: 'src/main.ts',
      uri: URI.file('/repo/src/main.ts').toString(),
    })
  })

  it('clears the draft after the prompt is sent', () => {
    const session = makeSession({ id: 's1' })
    renderWithServices(<PromptInput session={session} />)
    const ta = getTextarea()
    fireEvent.change(ta, { target: { value: 'send me' } })
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(session.sendPrompt).toHaveBeenCalledWith('send me', [], [], [])
    expect(AcpPromptDraftCache.load('s1')).toBeUndefined()
  })

  describe('image attachments', () => {
    function makeImageFile(name = 'shot.png', type = 'image/png', size = 128): File {
      const file = new File([new Uint8Array(size)], name, { type })
      // happy-dom's File doesn't always reflect byte length in `size`; force it.
      Object.defineProperty(file, 'size', { value: size })
      return file
    }

    function pasteImage(ta: HTMLTextAreaElement, file: File): void {
      fireEvent.paste(ta, {
        clipboardData: {
          items: [{ kind: 'file', type: file.type, getAsFile: () => file }],
          files: [file],
        },
      })
    }

    it('pasting an image attaches a chip when the agent supports images', async () => {
      const session = makeSession({ imageSupported: true })
      renderWithServices(<PromptInput session={session} />)
      const ta = getTextarea()
      pasteImage(ta, makeImageFile())
      // FileReader → base64 is async; the chip appears once the read settles.
      expect(await screen.findByTestId('acp-prompt-image-chips')).toBeTruthy()
      expect(notifySpy).not.toHaveBeenCalled()
    })

    it('sends attached images with the prompt', async () => {
      const session = makeSession({ imageSupported: true })
      renderWithServices(<PromptInput session={session} />)
      const ta = getTextarea()
      pasteImage(ta, makeImageFile())
      await screen.findByTestId('acp-prompt-image-chips')
      fireEvent.change(ta, { target: { value: 'look at this' } })
      fireEvent.keyDown(ta, { key: 'Enter' })
      const call = session.sendPrompt.mock.calls[0]
      expect(call).toBeDefined()
      const [text, mentions, contexts, images] = call!
      expect(text).toBe('look at this')
      expect(mentions).toEqual([])
      expect(contexts).toEqual([])
      expect(images).toHaveLength(1)
      expect(images[0].mimeType).toBe('image/png')
    })

    it('rejects the paste and warns when the agent does not support images', async () => {
      const session = makeSession({ imageSupported: false })
      renderWithServices(<PromptInput session={session} />)
      const ta = getTextarea()
      pasteImage(ta, makeImageFile())
      await waitFor(() => expect(notifySpy).toHaveBeenCalledTimes(1))
      expect(screen.queryByTestId('acp-prompt-image-chips')).toBeNull()
    })

    // Monaco's editContext:true host hides image bytes from the sync
    // ClipboardEvent (files/items come back empty), and navigator.clipboard is
    // blocked by an unset Electron permission — so the image is read from the
    // main process via IHostService. Regression guard for the migration bug.
    it('attaches a pasted image via the host clipboard when the sync event is empty', async () => {
      nextClipboardImage = {
        dataBase64: btoa('fake-png-bytes'),
        mimeType: 'image/png',
        byteSize: 64,
      }
      const session = makeSession({ imageSupported: true })
      renderWithServices(<PromptInput session={session} />)
      const ta = getTextarea()
      // Empty sync clipboard — mirrors the EditContext ClipboardEvent.
      fireEvent.paste(ta, { clipboardData: { items: [], files: [] } })
      expect(await screen.findByTestId('acp-prompt-image-chips')).toBeTruthy()
      expect(readClipboardImageSpy).toHaveBeenCalledTimes(1)
      expect(notifySpy).not.toHaveBeenCalled()
    })

    it('does not read the host clipboard when the agent lacks image support', async () => {
      const session = makeSession({ imageSupported: false })
      renderWithServices(<PromptInput session={session} />)
      const ta = getTextarea()
      fireEvent.paste(ta, { clipboardData: { items: [], files: [] } })
      expect(readClipboardImageSpy).not.toHaveBeenCalled()
    })

    it('dragging an in-app image (URI only, no File) attaches it', async () => {
      const session = makeSession({ imageSupported: true })
      renderWithServices(<PromptInput session={session} />)
      const ta = getTextarea()
      const uri = URI.file('/repo/assets/pic.png').toString()
      // A resource drop must be claimed (default prevented) so it never bubbles
      // to the editor group body, which would open the image as an editor.
      const notPrevented = fireEvent.drop(ta, {
        dataTransfer: {
          files: [],
          types: ['text/uri-list'],
          getData: (mime: string) => (mime === 'text/uri-list' ? uri : ''),
        },
      })
      expect(notPrevented).toBe(false)
      // The image is read via IFileService and attached as a chip.
      expect(await screen.findByTestId('acp-prompt-image-chips')).toBeTruthy()
    })
  })
})
