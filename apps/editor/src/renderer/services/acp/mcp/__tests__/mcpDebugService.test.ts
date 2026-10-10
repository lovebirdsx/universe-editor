/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/acp/mcp/mcpDebugService.ts
 *
 *  The service owns policy — which card may be replayed, what the user confirms,
 *  what each tab remembers — so these tests drive it with fakes and assert the
 *  *sequence* of side effects (resolve → confirm → connect → call), not the wire.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import {
  Emitter,
  Severity,
  type EditorInput,
  type IConfirmOptions,
  type IConfirmResult,
  type IEditorGroupsService,
  type IInstantiationService,
  type INotificationService,
} from '@universe-editor/platform'
import type {
  IMcpClientService,
  McpCallResultDto,
  McpConnectResultDto,
  McpConnectTargetDto,
  McpConnectionClosedDto,
  McpToolInfoDto,
} from '../../../../../shared/ipc/mcpClientService.js'
import { StubLoggerService } from '../../../../__tests__/_helpers/stubLoggerService.js'
import type { AcpToolCall, IAcpSession } from '../../session/acpSessionModel.js'
import type {
  IAcpSessionService,
  McpServerConnectionResolution,
} from '../../session/acpSessionService.js'
import { McpDebugEditorInput } from '../mcpDebugEditorInput.js'
import { debugKey, McpDebugService } from '../mcpDebugService.js'

class FakeGroup {
  readonly editors: EditorInput[] = []
  private _active: EditorInput | undefined

  get activeEditor(): EditorInput | undefined {
    return this._active
  }

  setActive(editor: EditorInput): void {
    this._active = editor
  }

  openEditor(input: EditorInput): EditorInput {
    if (!this.editors.includes(input)) this.editors.push(input)
    this._active = input
    return input
  }
}

class FakeGroupsService {
  readonly groups: FakeGroup[] = [new FakeGroup()]
  readonly activated: FakeGroup[] = []

  get activeGroup(): FakeGroup {
    return this.groups[0]!
  }

  get activeGroupForOpen(): FakeGroup {
    return this.groups[0]!
  }

  activateGroup(group: FakeGroup): void {
    this.activated.push(group)
  }
}

class FakeClient implements IMcpClientService {
  declare readonly _serviceBrand: undefined
  readonly calls: string[] = []
  readonly targets: McpConnectTargetDto[] = []
  readonly disconnected: string[] = []
  connectCount = 0
  connectError: unknown
  /** Holds the handshake open so a test can act while it is in flight. */
  connectGate: Promise<void> | undefined
  callError: unknown
  tools: readonly McpToolInfoDto[] = [
    {
      name: 'echo',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    },
  ]
  callResult: McpCallResultDto = {
    isError: false,
    content: [{ type: 'text', text: 'ok' }],
    durationMs: 3,
  }

  private readonly _onDidClose = new Emitter<McpConnectionClosedDto>()
  readonly onDidCloseConnection = this._onDidClose.event

  async connect(target: McpConnectTargetDto): Promise<McpConnectResultDto> {
    this.connectCount++
    this.calls.push('connect')
    this.targets.push(target)
    if (this.connectGate !== undefined) await this.connectGate
    if (this.connectError !== undefined) throw this.connectError
    return {
      connectionId: `conn-${this.connectCount}`,
      serverName: 'fixture',
      serverVersion: '1.0.0',
      tools: this.tools,
    }
  }

  async listTools(): Promise<readonly McpToolInfoDto[]> {
    this.calls.push('listTools')
    return this.tools
  }

  async callTool(_id: string, tool: string): Promise<McpCallResultDto> {
    this.calls.push(`call:${tool}`)
    if (this.callError !== undefined) throw this.callError
    return this.callResult
  }

  async disconnect(connectionId: string): Promise<void> {
    this.calls.push(`disconnect:${connectionId}`)
    this.disconnected.push(connectionId)
  }

  fireClose(event: McpConnectionClosedDto): void {
    this._onDidClose.fire(event)
  }
}

class FakeSessions {
  declare readonly _serviceBrand: undefined
  resolution: McpServerConnectionResolution = {
    kind: 'ok',
    server: { name: 'fs', command: 'node', args: ['server.cjs'], env: [] },
  }
  readonly requests: Array<{ agentId: string | undefined; serverName: string; cwd?: string }> = []

  async resolveMcpServerConnection(args: {
    agentId: string | undefined
    serverName: string
    cwd?: string
  }): Promise<McpServerConnectionResolution> {
    this.requests.push(args)
    return this.resolution
  }
}

class FakeDialogs {
  declare readonly _serviceBrand: undefined
  answer: IConfirmResult = { confirmed: true, choice: 'primary' }
  readonly options: IConfirmOptions[] = []

  async confirm(opts: IConfirmOptions): Promise<IConfirmResult> {
    this.options.push(opts)
    return this.answer
  }

  async prompt(): Promise<string | undefined> {
    return undefined
  }
}

class FakeNotifications {
  declare readonly _serviceBrand: undefined
  readonly messages: Array<{ severity: Severity; message: string }> = []

  notify(entry: { severity: Severity; message: string }): void {
    this.messages.push(entry)
  }
}

function makeSession(overrides: Partial<IAcpSession> = {}): IAcpSession {
  return {
    id: 'session-1',
    agentId: 'claude-code',
    cwd: undefined,
    authority: undefined,
    ...overrides,
  } as unknown as IAcpSession
}

/**
 * `Partial<AcpToolCall>` cannot express "clear this field" under
 * `exactOptionalPropertyTypes`, and the visibility cases below need exactly that.
 */
type CallPatch = { [K in keyof AcpToolCall]?: AcpToolCall[K] | undefined }

function makeCall(overrides: CallPatch = {}): AcpToolCall {
  return {
    id: 'call-1',
    title: 'Read file',
    kind: 'other',
    status: 'completed',
    text: '',
    blocks: [],
    diffs: [],
    mcpServer: 'fs',
    mcpTool: 'read_file',
    rawInput: { path: '/tmp/a' },
    ...overrides,
  } as AcpToolCall
}

function makeService(overrides: { sessions?: FakeSessions; client?: FakeClient } = {}) {
  const sessions = overrides.sessions ?? new FakeSessions()
  const client = overrides.client ?? new FakeClient()
  const dialogs = new FakeDialogs()
  const notifications = new FakeNotifications()
  const groups = new FakeGroupsService()
  const inst = {
    createInstance: (ctor: new (...args: never[]) => unknown, ...args: unknown[]) =>
      new ctor(...(args as never[])),
  } as unknown as IInstantiationService
  const service = new McpDebugService(
    sessions as unknown as IAcpSessionService,
    client,
    dialogs,
    notifications as unknown as INotificationService,
    groups as unknown as IEditorGroupsService,
    inst,
    new StubLoggerService(),
  )
  return { service, sessions, client, dialogs, notifications, groups }
}

/** The single tab the service should have opened, or `undefined`. */
function openedInput(groups: FakeGroupsService): McpDebugEditorInput | undefined {
  const editors = groups.groups[0]!.editors
  return editors.find((e): e is McpDebugEditorInput => e instanceof McpDebugEditorInput)
}

describe('openFromToolCall', () => {
  it('resolves, confirms, opens a tab and runs the call once', async () => {
    const { service, client, dialogs, groups, sessions } = makeService()
    await service.openFromToolCall(makeSession(), makeCall())

    expect(sessions.requests).toEqual([{ agentId: 'claude-code', serverName: 'fs' }])
    expect(dialogs.options).toHaveLength(1)
    expect(client.calls).toEqual(['connect', 'call:read_file'])
    expect(openedInput(groups)?.key).toBe(debugKey('session-1', 'fs'))
    expect(service.getState(debugKey('session-1', 'fs'))?.get().connection).toBe('connected')
  })

  it('passes the session cwd through so relative args resolve like the agent saw them', async () => {
    const { service, client, sessions } = makeService()
    await service.openFromToolCall(makeSession({ cwd: 'X:/workspace' }), makeCall())
    expect(sessions.requests[0]?.cwd).toBe('X:/workspace')
    expect((client.targets[0] as { cwd?: string }).cwd).toBe('X:/workspace')
  })

  it('does nothing when the user cancels — no spawn, no tab', async () => {
    const { service, client, dialogs, groups } = makeService()
    dialogs.answer = { confirmed: false, choice: 'cancel' }
    await service.openFromToolCall(makeSession(), makeCall())
    expect(client.calls).toEqual([])
    expect(openedInput(groups)).toBeUndefined()
  })

  it('shows the params in the confirm dialog', async () => {
    const { service, dialogs } = makeService()
    await service.openFromToolCall(makeSession(), makeCall({ rawInput: { path: '/tmp/a' } }))
    expect(dialogs.options[0]?.detail).toContain('"path": "/tmp/a"')
    expect(dialogs.options[0]?.detail).toContain('Server:   fs (stdio)')
  })

  it.each([
    ['no mcp attribution', { mcpServer: undefined }],
    ['no tool segment', { mcpTool: undefined }],
  ])('ignores a card with %s — nothing to say, nothing to dial', async (_label, overrides) => {
    const { service, client, dialogs, notifications, groups } = makeService()
    await service.openFromToolCall(makeSession(), makeCall(overrides))
    expect(client.calls).toEqual([])
    expect(dialogs.options).toEqual([])
    expect(notifications.messages).toEqual([])
    expect(openedInput(groups)).toBeUndefined()
  })

  it.each([
    ['param released by the memory budget', { rawInput: undefined }],
    ['card flagged as trimmed', { memoryTrimmed: true as const }],
  ])('explains why a card whose %s cannot be replayed', async (_label, overrides) => {
    const { service, client, dialogs, notifications } = makeService()
    await service.openFromToolCall(makeSession(), makeCall(overrides))
    expect(client.calls).toEqual([])
    expect(dialogs.options).toEqual([])
    expect(notifications.messages).toHaveLength(1)
    expect(notifications.messages[0]?.message).toContain('replayed')
  })

  it('warns instead of dialling when the server is not in the configuration', async () => {
    const { service, sessions, client, dialogs, notifications } = makeService()
    sessions.resolution = { kind: 'not-found' }
    await service.openFromToolCall(makeSession(), makeCall())
    expect(client.calls).toEqual([])
    expect(dialogs.options).toHaveLength(0)
    expect(notifications.messages[0]?.message).toContain('fs')
  })

  it('warns when the server is served over the ACP connection', async () => {
    const { service, sessions, client, notifications } = makeService()
    sessions.resolution = {
      kind: 'ok',
      server: { name: 'fs', type: 'acp', id: 'fs' } as never,
    }
    await service.openFromToolCall(makeSession(), makeCall())
    expect(client.calls).toEqual([])
    expect(notifications.messages[0]?.message).toContain('ACP')
  })

  it('does not touch main for a remote workspace', async () => {
    const { service, sessions, client, notifications } = makeService()
    await service.openFromToolCall(makeSession({ authority: 'ssh-remote+host' }), makeCall())
    expect(sessions.requests).toEqual([])
    expect(client.calls).toEqual([])
    expect(notifications.messages[0]?.message).toContain('Remote')
  })

  it('re-opening the same debugger from another card reuses the tab and keeps the connection', async () => {
    const { service, client, groups } = makeService()
    await service.openFromToolCall(makeSession(), makeCall())
    await service.openFromToolCall(
      makeSession(),
      makeCall({ id: 'call-2', mcpTool: 'write_file', rawInput: { path: '/tmp/b' } }),
    )
    expect(groups.groups[0]!.editors).toHaveLength(1)
    expect(client.connectCount).toBe(1)
    const state = service.getState(debugKey('session-1', 'fs'))!.get()
    expect(state.selectedTool).toBe('write_file')
    expect(state.paramsText).toContain('/tmp/b')
    expect(state.history.map((entry) => entry.tool)).toEqual(['write_file', 'read_file'])
  })

  it('reports a connect failure in the tab instead of throwing', async () => {
    const { service, client } = makeService()
    client.connectError = Object.assign(new Error('ENOENT'), { code: 'MCP_SPAWN_FAILED' })
    await service.openFromToolCall(makeSession(), makeCall())
    const state = service.getState(debugKey('session-1', 'fs'))!.get()
    expect(state.connection).toBe('failed')
    expect(state.connectionError).toBe('ENOENT')
    // One attempt, not a retry into the same failure: the tab already says why.
    expect(client.connectCount).toBe(1)
  })

  it('does not dial a read-only session preview', async () => {
    const { service, sessions, client, notifications } = makeService()
    await service.openFromToolCall(makeSession({ readOnly: true }), makeCall())
    expect(sessions.requests).toEqual([])
    expect(client.calls).toEqual([])
    expect(notifications.messages[0]?.message).toContain('read-only')
  })

  it('drops the held connection when a re-open targets a different definition', async () => {
    const { service, sessions, client } = makeService()
    await service.openFromToolCall(makeSession(), makeCall())
    sessions.resolution = {
      kind: 'ok',
      server: { name: 'fs', command: 'node', args: ['other.cjs'], env: [] },
    }
    await service.openFromToolCall(makeSession(), makeCall())

    expect(client.disconnected).toEqual(['conn-1'])
    expect(client.connectCount).toBe(2)
    expect((client.targets.at(-1) as { args: readonly string[] }).args).toEqual(['other.cjs'])
  })

  it('shares one handshake between Runs racing the initial connect', async () => {
    const { service, client } = makeService()
    const key = debugKey('session-1', 'fs')
    let release!: () => void
    client.connectGate = new Promise<void>((resolve) => {
      release = resolve
    })

    const opening = service.openFromToolCall(makeSession(), makeCall())
    await vi.waitFor(() => expect(client.connectCount).toBe(1))
    // The panel is already live and its Run button is enabled: this is the Run the
    // user presses because the tab looks stuck.
    const racing = service.runTool(key)
    release()
    await Promise.all([opening, racing])

    expect(client.connectCount).toBe(1)
    expect(client.calls.filter((c) => c.startsWith('call:'))).toHaveLength(1)
  })

  it('releases a connection that lands after the tab was closed', async () => {
    const { service, client, groups } = makeService()
    let release!: () => void
    client.connectGate = new Promise<void>((resolve) => {
      release = resolve
    })

    const opening = service.openFromToolCall(makeSession(), makeCall())
    await vi.waitFor(() => expect(client.connectCount).toBe(1))
    openedInput(groups)!.dispose()
    release()
    await opening

    expect(service.getState(debugKey('session-1', 'fs'))).toBeUndefined()
    expect(client.disconnected).toEqual(['conn-1'])
  })
})

describe('runTool', () => {
  async function connected() {
    const ctx = makeService()
    await ctx.service.openFromToolCall(makeSession(), makeCall())
    return ctx
  }

  it('parses the box, calls the tool and records history newest-first', async () => {
    const { service, client } = await connected()
    const key = debugKey('session-1', 'fs')
    service.setParamsText(key, '{"text": "hi"}')
    await service.runTool(key)

    expect(client.calls).toEqual(['connect', 'call:read_file', 'call:read_file'])
    const state = service.getState(key)!.get()
    expect(state.lastResult?.content).toEqual([{ type: 'text', text: 'ok' }])
    expect(state.history[0]?.paramsText).toBe('{"text": "hi"}')
    expect(state.running).toBe(false)
  })

  it('refuses to call on invalid JSON', async () => {
    const { service, client } = await connected()
    const key = debugKey('session-1', 'fs')
    service.setParamsText(key, '{')
    await service.runTool(key)
    expect(client.calls).toEqual(['connect', 'call:read_file'])
    expect(service.getState(key)!.get().lastError).toContain('Invalid JSON')
  })

  it('records a transport failure in history and clears the dead connection', async () => {
    const { service, client } = await connected()
    const key = debugKey('session-1', 'fs')
    client.callError = Object.assign(new Error('gone'), { code: 'MCP_UNKNOWN_CONNECTION' })
    await service.runTool(key)

    const state = service.getState(key)!.get()
    expect(state.lastError).toBe('gone')
    expect(state.connection).toBe('idle')
    expect(state.history[0]?.isError).toBe(true)
    expect(state.history[0]?.error).toBe('gone')
  })

  it('passes a server-reported isError through as a normal reply', async () => {
    const { service, client } = await connected()
    const key = debugKey('session-1', 'fs')
    client.callResult = { isError: true, content: [{ type: 'text', text: 'boom' }], durationMs: 1 }
    await service.runTool(key)

    const state = service.getState(key)!.get()
    expect(state.lastError).toBeUndefined()
    expect(state.lastResult?.isError).toBe(true)
    expect(state.history[0]?.isError).toBe(true)
  })

  it('reconnects once after the server went away', async () => {
    const { service, client } = await connected()
    const key = debugKey('session-1', 'fs')
    client.fireClose({ connectionId: 'conn-1', reason: 'server-exit', detail: 'boom' })
    expect(service.getState(key)!.get().connection).toBe('idle')

    await service.runTool(key)
    expect(client.connectCount).toBe(2)
    expect(client.calls.at(-1)).toBe('call:read_file')
    expect(service.getState(key)!.get().connection).toBe('connected')
  })

  it('does not reconnect into a second failure', async () => {
    const { service, client } = await connected()
    const key = debugKey('session-1', 'fs')
    await service.disconnect(key)
    client.connectError = Object.assign(new Error('nope'), { code: 'MCP_CONNECT_FAILED' })
    await service.runTool(key)
    expect(client.calls.at(-1)).toBe('connect')
    expect(service.getState(key)!.get().connection).toBe('failed')
  })

  it('caps the history at 50 entries', async () => {
    const { service } = await connected()
    const key = debugKey('session-1', 'fs')
    for (let i = 0; i < 60; i++) await service.runTool(key)
    expect(service.getState(key)!.get().history).toHaveLength(50)
  })
})

describe('tool selection and params', () => {
  it('seeds a skeleton from the schema until the user types', async () => {
    const { service, client } = makeService()
    client.tools = [
      { name: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
      { name: 'other', inputSchema: { type: 'object', properties: { n: { type: 'integer' } } } },
    ]
    await service.openFromToolCall(makeSession(), makeCall())
    const key = debugKey('session-1', 'fs')

    service.selectTool(key, 'other')
    expect(service.getState(key)!.get().paramsText).toBe('{\n  "n": 0\n}')

    service.setParamsText(key, '{"n": 7}')
    service.selectTool(key, 'echo')
    expect(service.getState(key)!.get().paramsText).toBe('{"n": 7}')
    expect(service.getState(key)!.get().selectedTool).toBe('echo')
  })

  it('ignores calls for an unknown tab', () => {
    const { service } = makeService()
    expect(service.getState('nope')).toBeUndefined()
    expect(() => {
      service.selectTool('nope', 'a')
      service.setParamsText('nope', 'x')
      service.clearHistory('nope')
      service.releaseKey('nope')
    }).not.toThrow()
  })
})

describe('refreshTools', () => {
  it('replaces the tool list', async () => {
    const { service, client } = makeService()
    await service.openFromToolCall(makeSession(), makeCall())
    const key = debugKey('session-1', 'fs')
    client.tools = [{ name: 'added' }]
    await service.refreshTools(key)
    expect(
      service
        .getState(key)!
        .get()
        .tools.map((t) => t.name),
    ).toEqual(['added'])
  })

  it('surfaces a failure without dropping the list', async () => {
    const { service, client } = makeService()
    await service.openFromToolCall(makeSession(), makeCall())
    const key = debugKey('session-1', 'fs')
    client.listTools = async () => {
      throw Object.assign(new Error('closed'), { code: 'MCP_UNKNOWN_CONNECTION' })
    }
    await service.refreshTools(key)
    const state = service.getState(key)!.get()
    expect(state.toolsError).toBe('closed')
    expect(state.tools.map((t) => t.name)).toEqual(['echo'])
  })
})

describe('connection lifecycle', () => {
  it('disconnect keeps the tab (and its history) but drops the connection', async () => {
    const { service, client } = makeService()
    await service.openFromToolCall(makeSession(), makeCall())
    const key = debugKey('session-1', 'fs')
    await service.disconnect(key)

    expect(client.disconnected).toEqual(['conn-1'])
    const state = service.getState(key)!.get()
    expect(state.connection).toBe('idle')
    expect(state.history).toHaveLength(1)
  })

  it('an idle reap reported by main shows up as a warning', async () => {
    const { service, client } = makeService()
    await service.openFromToolCall(makeSession(), makeCall())
    const key = debugKey('session-1', 'fs')
    client.fireClose({ connectionId: 'conn-1', reason: 'idle' })
    const state = service.getState(key)!.get()
    expect(state.connection).toBe('idle')
    expect(state.warning).toContain('idle connection')
  })

  it('ignores close events for connections it does not hold', async () => {
    const { service, client } = makeService()
    await service.openFromToolCall(makeSession(), makeCall())
    const key = debugKey('session-1', 'fs')
    client.fireClose({ connectionId: 'someone-else', reason: 'server-exit' })
    expect(service.getState(key)!.get().connection).toBe('connected')
  })

  it('closing the tab releases the state and disconnects', async () => {
    const { service, client, groups } = makeService()
    await service.openFromToolCall(makeSession(), makeCall())
    const key = debugKey('session-1', 'fs')
    openedInput(groups)!.dispose()

    expect(service.getState(key)).toBeUndefined()
    expect(client.disconnected).toEqual(['conn-1'])
  })

  it('disposing the service tears every tab down', async () => {
    const { service, client } = makeService()
    await service.openFromToolCall(makeSession(), makeCall())
    await service.openFromToolCall(makeSession({ id: 'session-2' }), makeCall())
    expect(client.connectCount).toBe(2)

    service.dispose()
    expect(client.disconnected).toEqual(['conn-1', 'conn-2'])
    expect(service.getState(debugKey('session-2', 'fs'))).toBeUndefined()
  })
})

describe('clearHistory', () => {
  it('empties the list without touching the connection', async () => {
    const { service, client } = makeService()
    await service.openFromToolCall(makeSession(), makeCall())
    const key = debugKey('session-1', 'fs')
    service.clearHistory(key)
    expect(service.getState(key)!.get().history).toEqual([])
    expect(client.disconnected).toEqual([])
  })

  it('ignores a second Run while one is in flight', async () => {
    const { service, client } = makeService()
    await service.openFromToolCall(makeSession(), makeCall())
    const key = debugKey('session-1', 'fs')
    await Promise.all([service.runTool(key), service.runTool(key)])
    expect(client.calls.filter((c) => c.startsWith('call:'))).toHaveLength(2)
    expect(service.getState(key)!.get().history).toHaveLength(2)
  })

  it('gives rapid calls distinct history ids, even in the same millisecond', async () => {
    const { service } = makeService()
    await service.openFromToolCall(makeSession(), makeCall())
    const key = debugKey('session-1', 'fs')
    await service.runTool(key)
    await service.runTool(key)
    const ids = service
      .getState(key)!
      .get()
      .history.map((entry) => entry.id)
    expect(ids).toHaveLength(3)
    expect(new Set(ids).size).toBe(3)
  })
})

describe('restore', () => {
  it('puts a past call’s tool and params back in the box', async () => {
    const { service } = makeService()
    await service.openFromToolCall(makeSession(), makeCall())
    const key = debugKey('session-1', 'fs')
    service.setParamsText(key, '{"text": "second"}')
    await service.runTool(key)

    const first = service.getState(key)!.get().history[1]!
    service.selectTool(key, 'echo')
    service.restore(key, first.id)

    const state = service.getState(key)!.get()
    expect(state.selectedTool).toBe('read_file')
    expect(state.paramsText).toBe('{\n  "path": "/tmp/a"\n}')
  })

  it('ignores an unknown entry id', async () => {
    const { service } = makeService()
    await service.openFromToolCall(makeSession(), makeCall())
    const key = debugKey('session-1', 'fs')
    const before = service.getState(key)!.get().paramsText
    service.restore(key, 'nope')
    expect(service.getState(key)!.get().paramsText).toBe(before)
  })
})
