/*---------------------------------------------------------------------------------------------
 *  Tests for PromptInput's slash-command keyboard wiring + send/cancel
 *  behaviour. The session is a tiny stub backed by real observableValue
 *  instances so useObservable inside the component reacts to changes.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import {
  Event,
  IFileSearchService,
  InstantiationService,
  IWorkspaceService,
  observableValue,
  ServiceCollection,
  URI,
} from '@universe-editor/platform'
import type {
  IFileSearchService as IFileSearchServiceType,
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

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  invalidateMentionFileCache()
  AcpPromptDraftCache._resetForTests()
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
    title: 'Fake',
    messages,
    toolCalls,
    plan,
    timeline,
    status: statusObs,
    usage: observableValue<AcpUsage | undefined>('test.usage', opts.usage),
    pendingPermission: permission,
    pendingQuestion: observableValue<AcpPendingQuestion | undefined>('test.question', undefined),
    configOptions,
    availableCommands: commandsObs,
    mcpServers: observableValue('test.mcpServers', []),
    collapseMode: observableValue('test.collapseMode', 'default' as const),
    presentPermission: () => {},
    presentQuestion: () => {},
    sendPrompt: sendPrompt as never,
    cancelTurn: cancelTurn as never,
    close: () => Promise.resolve(),
    setConfigOption: () => Promise.resolve(),
    cycleCollapseMode: () => {},
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

describe('extractSlashQuery', () => {
  it('returns the substring after the leading slash', () => {
    expect(extractSlashQuery('/diff')).toBe('diff')
    expect(extractSlashQuery('/')).toBe('')
  })

  it('returns null when text does not start with slash', () => {
    expect(extractSlashQuery('hello')).toBeNull()
    expect(extractSlashQuery(' /diff')).toBeNull()
  })

  it('returns null once whitespace has been typed (command name closed)', () => {
    expect(extractSlashQuery('/diff foo')).toBeNull()
    expect(extractSlashQuery('/diff ')).toBeNull()
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

  it('hides the popover once whitespace closes the command token', () => {
    renderWithServices(<PromptInput session={makeSession({ commands: COMMANDS })} />)
    const ta = getTextarea()
    fireEvent.change(ta, { target: { value: '/diff' } })
    expect(screen.getByTestId('acp-slash-popover')).toBeTruthy()
    fireEvent.change(ta, { target: { value: '/diff ' } })
    expect(screen.queryByTestId('acp-slash-popover')).toBeNull()
  })
})

describe('PromptInput — slash keyboard navigation', () => {
  it('ArrowDown advances the active item, wrapping at the end', () => {
    renderWithServices(<PromptInput session={makeSession({ commands: COMMANDS })} />)
    const ta = getTextarea()
    fireEvent.change(ta, { target: { value: '/' } })
    expect(screen.getAllByRole('option')[0]?.getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(ta, { key: 'ArrowDown' })
    expect(screen.getAllByRole('option')[1]?.getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(ta, { key: 'ArrowDown' })
    expect(screen.getAllByRole('option')[2]?.getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(ta, { key: 'ArrowDown' })
    // wraps back to 0
    expect(screen.getAllByRole('option')[0]?.getAttribute('aria-selected')).toBe('true')
  })

  it('ArrowUp moves backwards, wrapping at the start', () => {
    renderWithServices(<PromptInput session={makeSession({ commands: COMMANDS })} />)
    const ta = getTextarea()
    fireEvent.change(ta, { target: { value: '/' } })
    fireEvent.keyDown(ta, { key: 'ArrowUp' })
    expect(screen.getAllByRole('option')[2]?.getAttribute('aria-selected')).toBe('true')
  })

  it('Enter on the active item inserts the command name (does not submit)', () => {
    const session = makeSession({ commands: COMMANDS })
    renderWithServices(<PromptInput session={session} />)
    const ta = getTextarea()
    fireEvent.change(ta, { target: { value: '/' } })
    fireEvent.keyDown(ta, { key: 'ArrowDown' }) // /diff
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(ta.value).toBe('/diff ')
    expect(session.sendPrompt).not.toHaveBeenCalled()
    // popover hides because user dismissed it; new value still has no space yet would
    // re-open, but we set the trailing space so query == null and popover stays closed.
    expect(screen.queryByTestId('acp-slash-popover')).toBeNull()
  })

  it('Tab accepts the active item just like Enter', () => {
    renderWithServices(<PromptInput session={makeSession({ commands: COMMANDS })} />)
    const ta = getTextarea()
    fireEvent.change(ta, { target: { value: '/' } })
    fireEvent.keyDown(ta, { key: 'Tab' })
    expect(ta.value).toBe('/help ')
  })

  it('Escape dismisses the popover without clearing the input', () => {
    renderWithServices(<PromptInput session={makeSession({ commands: COMMANDS })} />)
    const ta = getTextarea()
    fireEvent.change(ta, { target: { value: '/d' } })
    expect(screen.getByTestId('acp-slash-popover')).toBeTruthy()
    fireEvent.keyDown(ta, { key: 'Escape' })
    expect(screen.queryByTestId('acp-slash-popover')).toBeNull()
    expect(ta.value).toBe('/d')
  })

  it('mouse-clicking a row inserts that command', () => {
    renderWithServices(<PromptInput session={makeSession({ commands: COMMANDS })} />)
    const ta = getTextarea()
    fireEvent.change(ta, { target: { value: '/' } })
    const options = screen.getAllByRole('option')
    fireEvent.mouseDown(options[2]!)
    expect(ta.value).toBe('/clear ')
  })

  it('accepts a command name that already has a leading slash without doubling it', () => {
    // 部分 agent 实现会把 `/` 写进 name 字段（schema 推荐不带）。两种形态都要还原成 `/<name> `。
    const prefixed: readonly AvailableCommand[] = [{ name: '/diff', description: 'show diff' }]
    renderWithServices(<PromptInput session={makeSession({ commands: prefixed })} />)
    const ta = getTextarea()
    fireEvent.change(ta, { target: { value: '/' } })
    fireEvent.keyDown(ta, { key: 'Enter' })
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
})

describe('PromptInput — submit and cancel', () => {
  it('Enter (no popover) calls sendPrompt and clears the textarea', () => {
    const session = makeSession()
    renderWithServices(<PromptInput session={session} />)
    const ta = getTextarea()
    fireEvent.change(ta, { target: { value: 'hello world' } })
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(session.sendPrompt).toHaveBeenCalledWith('hello world', [])
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
    expect(session.sendPrompt).toHaveBeenCalledWith('steer left', [])
    expect(ta.value).toBe('')
  })

  it('Escape interrupts the running turn when no popover is open', () => {
    const session = makeSession({ status: 'running' })
    renderWithServices(<PromptInput session={session} />)
    fireEvent.keyDown(getTextarea(), { key: 'Escape' })
    expect(session.cancelTurn).toHaveBeenCalledTimes(1)
  })

  it('Escape only closes the slash popover and does not cancel while running', () => {
    const session = makeSession({ status: 'running', commands: COMMANDS })
    renderWithServices(<PromptInput session={session} />)
    const ta = getTextarea()
    fireEvent.change(ta, { target: { value: '/d' } })
    expect(screen.getByTestId('acp-slash-popover')).toBeTruthy()
    fireEvent.keyDown(ta, { key: 'Escape' })
    expect(screen.queryByTestId('acp-slash-popover')).toBeNull()
    expect(session.cancelTurn).not.toHaveBeenCalled()
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

describe('PromptInput — textarea sizing and browser checks', () => {
  it('disables browser spellcheck underlines', () => {
    renderWithServices(<PromptInput session={makeSession()} />)
    expect(getTextarea().getAttribute('spellcheck')).toBe('false')
  })

  it('grows up to sixteen rows before enabling internal scrolling', () => {
    vi.spyOn(globalThis, 'getComputedStyle').mockReturnValue({
      lineHeight: '18px',
      fontSize: '12px',
      paddingTop: '3px',
      paddingBottom: '3px',
      borderTopWidth: '1px',
      borderBottomWidth: '1px',
    } as CSSStyleDeclaration)

    renderWithServices(<PromptInput session={makeSession()} />)
    const ta = getTextarea()
    Object.defineProperty(ta, 'scrollHeight', { value: 420, configurable: true })

    fireEvent.change(ta, {
      target: { value: Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') },
    })

    expect(ta.style.height).toBe('296px')
    expect(ta.style.overflowY).toBe('auto')
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

  it('Enter inserts the relative path and records the mention for send', async () => {
    const session = makeSession()
    renderWithServices(<PromptInput session={session} />, {
      workspace: makeWorkspaceService(URI.file('/repo')),
      fileSearch: makeFileSearch(FILES),
    })
    const ta = getTextarea()
    typeAt(ta, '@')
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    typeAt(ta, '@main')
    fireEvent.keyDown(ta, { key: 'Enter' })
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

  it('Escape dismisses the mention popover without clearing the text', async () => {
    renderWithServices(<PromptInput session={makeSession()} />, {
      workspace: makeWorkspaceService(URI.file('/repo')),
      fileSearch: makeFileSearch(FILES),
    })
    const ta = getTextarea()
    typeAt(ta, '@')
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(screen.getByTestId('acp-mention-popover')).toBeTruthy()
    fireEvent.keyDown(ta, { key: 'Escape' })
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
// Focus handoff — Ctrl+Alt+I command (via the AcpChatWidget handle) and the
// auto-focus on session swap. Both must land on the same textarea.
// ---------------------------------------------------------------------------

describe('PromptInput — focus handoff', () => {
  it('exposes focus() on the widget handle to focus the textarea', () => {
    const handleRef: { current: WidgetHandle } = {
      current: {
        move: () => {},
        scrollTimeline: () => {},
        focus: () => {},
        toggleCollapse: () => {},
        cycleCollapseMode: () => {},
      },
    }
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
    renderWithServices(<PromptInput session={session} />, opts)
    const ta = getTextarea()
    typeAt(ta, '@')
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    typeAt(ta, '@main')
    fireEvent.keyDown(ta, { key: 'Enter' }) // accept mention → records it
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
    expect(session.sendPrompt).toHaveBeenCalledWith('send me', [])
    expect(AcpPromptDraftCache.load('s1')).toBeUndefined()
  })
})
