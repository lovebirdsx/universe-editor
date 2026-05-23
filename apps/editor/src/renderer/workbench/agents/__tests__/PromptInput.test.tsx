/*---------------------------------------------------------------------------------------------
 *  Tests for PromptInput's slash-command keyboard wiring + send/cancel
 *  behaviour. The session is a tiny stub backed by real observableValue
 *  instances so useObservable inside the component reacts to changes.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import {
  Event,
  IFileService,
  InstantiationService,
  IWorkspaceService,
  observableValue,
  ServiceCollection,
  URI,
} from '@universe-editor/platform'
import type {
  IFileService as IFileServiceType,
  ISettableObservable,
  IWorkspace,
  IWorkspaceService as IWorkspaceServiceType,
} from '@universe-editor/platform'
import type {
  AcpMessage,
  AcpPendingPermission,
  AcpPlanEntry,
  AcpSessionStatus,
  AcpToolCall,
  IAcpSession,
} from '../../../services/acp/acpSessionService.js'
import type { AvailableCommand, SessionConfigOption } from '@agentclientprotocol/sdk'
import { invalidateMentionFileCache } from '../../../services/acp/mentionFileSearch.js'
import { PromptInput, extractSlashQuery } from '../PromptInput.js'
import { ServicesContext } from '../../useService.js'

afterEach(() => {
  cleanup()
  invalidateMentionFileCache()
})

const stubFileService: IFileServiceType = {
  _serviceBrand: undefined,
  async stat() {
    throw new Error('not implemented')
  },
  async exists() {
    return false
  },
  async readFile() {
    throw new Error('not implemented')
  },
  async writeFile() {},
  async readDirectory() {
    return []
  },
  async createDirectory() {},
  async delete() {},
  async rename() {},
  async listRecursive() {
    return []
  },
} as unknown as IFileServiceType

const stubWorkspaceService: IWorkspaceServiceType = {
  _serviceBrand: undefined,
  current: null,
  onDidChangeWorkspace: Event.None,
  recent: [],
  onDidChangeRecent: Event.None,
  async openFolder() {},
  async closeFolder() {},
  async clearRecent() {},
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

function makeFileService(paths: readonly string[]): IFileServiceType {
  return {
    ...stubFileService,
    async listRecursive() {
      return [...paths]
    },
  } as unknown as IFileServiceType
}

function renderWithServices(
  node: React.ReactNode,
  opts: { fileService?: IFileServiceType; workspace?: IWorkspaceServiceType } = {},
) {
  const services = new ServiceCollection()
  services.set(IFileService, opts.fileService ?? stubFileService)
  services.set(IWorkspaceService, opts.workspace ?? stubWorkspaceService)
  const inst = new InstantiationService(services)
  return render(<ServicesContext.Provider value={inst}>{node}</ServicesContext.Provider>)
}

interface FakeSessionOptions {
  readonly status?: AcpSessionStatus
  readonly commands?: readonly AvailableCommand[]
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
  const permission = observableValue<AcpPendingPermission | undefined>('test.permission', undefined)
  const configOptions = observableValue<readonly SessionConfigOption[]>('test.configOptions', [])
  const sendPrompt = vi.fn().mockResolvedValue(undefined)
  const cancelTurn = vi.fn().mockResolvedValue(undefined)
  return {
    id: 's1',
    agentId: 'fake',
    title: 'Fake',
    historyId: undefined,
    messages,
    toolCalls,
    plan,
    status: statusObs,
    pendingPermission: permission,
    configOptions,
    availableCommands: commandsObs,
    presentPermission: () => {},
    sendPrompt: sendPrompt as never,
    cancelTurn: cancelTurn as never,
    close: () => Promise.resolve(),
    setConfigOption: () => Promise.resolve(),
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

  it('switches to the Cancel button while the session is running', () => {
    const session = makeSession({ status: 'running' })
    renderWithServices(<PromptInput session={session} />)
    expect(screen.queryByTestId('acp-prompt-send')).toBeNull()
    const cancel = screen.getByTestId('acp-prompt-cancel')
    fireEvent.click(cancel)
    expect(session.cancelTurn).toHaveBeenCalledTimes(1)
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
      fileService: makeFileService(FILES),
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
      fileService: makeFileService(FILES),
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
      fileService: makeFileService(FILES),
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
      fileService: makeFileService(FILES),
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
      fileService: makeFileService(FILES),
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
