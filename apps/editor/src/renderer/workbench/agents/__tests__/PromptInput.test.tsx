/*---------------------------------------------------------------------------------------------
 *  Tests for PromptInput's slash-command keyboard wiring + send/cancel
 *  behaviour. The session is a tiny stub backed by real observableValue
 *  instances so useObservable inside the component reacts to changes.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react'
import {
  Event,
  IConfigurationService,
  IDialogService,
  IFileDialogService,
  IFileSearchService,
  IFileService,
  INotificationService,
  InstantiationService,
  IWorkspaceService,
  observableValue,
  ServiceCollection,
  URI,
} from '@universe-editor/platform'
import type {
  IConfigurationService as IConfigurationServiceType,
  IDialogService as IDialogServiceType,
  IFileDialogService as IFileDialogServiceType,
  IFileSearchService as IFileSearchServiceType,
  IFileService as IFileServiceType,
  INotificationService as INotificationServiceType,
  ISettableObservable,
  IWorkspace,
  IWorkspaceService as IWorkspaceServiceType,
} from '@universe-editor/platform'
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

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  notifySpy.mockClear()
  showOpenDialogSpy.mockClear()
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
  services.set(IFileDialogService, stubFileDialogService)
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

function makeDomRect(top: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    bottom: top,
    left: 0,
    right: 0,
    width: 0,
    height: 0,
    toJSON: () => ({}),
  } as DOMRect
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
  it('does not open history when ArrowUp should move within a soft-wrapped line', () => {
    setPromptHistory(['previous prompt'])
    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const probe = this.getAttribute('data-acp-prompt-line-probe')
      if (probe === 'start') return makeDomRect(10)
      if (probe === 'caret') return makeDomRect(34)
      return originalGetBoundingClientRect.call(this)
    })

    renderWithServices(<PromptInput session={makeSession()} />)
    const ta = getTextarea()
    Object.defineProperty(ta, 'clientWidth', { value: 120, configurable: true })
    const longLine = 'this is a long prompt line that wraps visually before the caret'
    fireEvent.change(ta, { target: { value: longLine } })
    ta.setSelectionRange(longLine.length, longLine.length)

    fireEvent.keyDown(ta, { key: 'ArrowUp' })

    expect(screen.queryByTestId('acp-history-popover')).toBeNull()
    expect(ta.value).toBe(longLine)
  })
})

describe('PromptInput — textarea sizing and browser checks', () => {
  it('disables browser spellcheck underlines', () => {
    renderWithServices(<PromptInput session={makeSession()} />)
    expect(getTextarea().getAttribute('spellcheck')).toBe('false')
  })

  it('relies on native field-sizing for auto-grow instead of JS height writes', () => {
    renderWithServices(<PromptInput session={makeSession()} />)
    const ta = getTextarea()

    fireEvent.change(ta, {
      target: { value: Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') },
    })

    // No inline height is written: sizing is delegated to CSS `field-sizing: content`
    // with min/max-height bounds, so the box can never get stuck at a stale pixel value.
    expect(ta.style.height).toBe('')
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

describe('PromptInput — @-mention popover', () => {
  const FILES = ['/repo/src/main.ts', '/repo/src/index.ts', '/repo/README.md']

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
    // PromptInput inserts the relative path with a trailing space.
    expect(ta.value).toContain('@src/main.ts')
    // The popover collapses (we dismissed it on accept).
    expect(screen.queryByTestId('acp-mention-popover')).toBeNull()
    // Submitting should hand the recorded mention to sendPrompt.
    fireEvent.change(ta, { target: { value: '@src/main.ts please review' } })
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(session.sendPrompt).toHaveBeenCalledTimes(1)
    const [, mentions] = session.sendPrompt.mock.calls[0]!
    expect(mentions).toEqual([
      { uri: URI.file('/repo/src/main.ts').toString(), name: 'src/main.ts' },
    ])
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
    // The `@@` trigger is gone; the workspace-relative mention is inserted.
    expect(ta.value).toBe('@src/main.ts ')
    // Submitting hands the recorded mention to sendPrompt.
    fireEvent.keyDown(ta, { key: 'Enter' })
    const [, mentions] = session.sendPrompt.mock.calls[0]!
    expect(mentions).toEqual([
      { uri: URI.file('/repo/src/main.ts').toString(), name: 'src/main.ts' },
    ])
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
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(ta.value).toBe('see @a.ts please')
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

  it('restores recorded mentions so a remounted draft still sends resource_links', async () => {
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
    act(() => handleRef.current.popoverAccept()) // accept mention → records it
    expect(ta.value).toContain('@src/main.ts')

    cleanup() // switch away: PromptInput unmounts, draft + mention cached
    renderWithServices(<PromptInput session={session} />, opts)
    const restored = getTextarea()
    expect(restored.value).toContain('@src/main.ts')
    fireEvent.keyDown(restored, { key: 'Enter' }) // submit the restored draft
    expect(session.sendPrompt).toHaveBeenCalledTimes(1)
    const [, mentions] = session.sendPrompt.mock.calls[0]!
    expect(mentions).toEqual([
      { uri: URI.file('/repo/src/main.ts').toString(), name: 'src/main.ts' },
    ])
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
