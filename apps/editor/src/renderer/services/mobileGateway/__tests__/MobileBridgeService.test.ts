import type { AvailableCommand, SessionConfigOption } from '@agentclientprotocol/sdk'
import { GitGraphCommands } from '@universe-editor/extensions-common'
import {
  MAX_TITLE_LENGTH,
  parseServerFrame,
  serializeFrame,
  type SessionSnapshotFrame,
} from '@universe-editor/mobile-protocol'
import {
  CancellationTokenSource,
  DeferredPromise,
  Emitter,
  Event,
  normalizePlatform,
  observableValue,
  URI,
  UriIdentityService,
  type IEditorGroupsService,
  type ICommandService,
  type IFileSearchComplete,
  type IFileSearchService,
  type IFileService,
  type IFileStat,
  type ILogger,
  type ILoggerService,
  type ISettableObservable,
  type IWorkspaceService,
} from '@universe-editor/platform'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AcpMcpServerStatus,
  AcpMessage,
  AcpPendingElicitation,
  AcpPermissionSettledEvent,
  AcpPendingPermission,
  AcpPlanEntry,
  AcpToolCall,
  AcpUsage,
  IAcpSession,
  TimelineItem,
} from '../../acp/session/acpSession.js'
import type { IAcpSessionService } from '../../acp/session/acpSessionService.js'
import type { McpServerDefinition } from '../../acp/acpMcpServers.js'
import type {
  ClaudeSettings,
  ClaudeSettingsPatch,
  IClaudeConfigService,
} from '../../../../shared/ipc/claudeConfigService.js'
import { AcpPromptDraftCache } from '../../acp/session/acpPromptDraftCache.js'
import type {
  AcpSessionHistoryEntry,
  IAcpSessionHistoryService,
} from '../../acp/session/acpSessionHistory.js'
import type { IAcpAgentRegistry } from '../../acp/acpAgentRegistry.js'
import type { IUserSettingsSyncService } from '../../configuration/UserSettingsSync.js'
import type { IScmService, IScmSourceControlModel } from '../../extensions/ScmService.js'
import type { IChatContextService } from '../../extensions/ChatContextService.js'
import type { IExcludeService } from '../../exclude/ExcludeService.js'
import {
  MOBILE_BRIDGE_LARGE_THROTTLE_MS,
  MOBILE_BRIDGE_THROTTLE_MS,
  MOBILE_DRAFT_ACK_TIMEOUT_MS,
  MOBILE_DRAFT_THROTTLE_MS,
  MOBILE_PENDING_WORK_SWEEP_MS,
  MobileBridgeService,
} from '../MobileBridgeService.js'
import type { ISessionDeliveryService } from '../../delivery/sessionDeliveryService.js'
import type { ISessionBranchPushService } from '../../delivery/sessionBranchPushService.js'
import type { ILanguageFeaturesService } from '../../languageFeatures/LanguageFeaturesService.js'
import type { DocCategory, IDocsService } from '../../../../shared/ipc/docsService.js'
import type {
  SessionDeliveryChange,
  SessionDeliveryPreview,
} from '../../delivery/sessionDeliveryTypes.js'
import type { MobileBridgeEvent } from '../../../../shared/ipc/mobileGatewayService.js'
import { invalidateMentionFileCache } from '../../acp/mentionFileSearch.js'
import { relativeTime } from '../../../relativeTime.js'

const NULL_LOGGER: ILogger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as ILogger

interface FakeSessionHarness {
  session: IAcpSession
  timeline: ISettableObservable<readonly TimelineItem[]>
  messages: ISettableObservable<readonly AcpMessage[]>
  toolCalls: ISettableObservable<readonly AcpToolCall[]>
  plan: ISettableObservable<readonly AcpPlanEntry[]>
  configOptions: ISettableObservable<readonly SessionConfigOption[]>
  availableCommands: ISettableObservable<readonly AvailableCommand[]>
  usage: ISettableObservable<AcpUsage | undefined>
  pendingPermission: ISettableObservable<AcpPendingPermission | undefined>
  pendingElicitation: ISettableObservable<AcpPendingElicitation | undefined>
  settlePermission: (event: AcpPermissionSettledEvent) => void
  status: ISettableObservable<'idle' | 'connecting' | 'running' | 'errored' | 'closed'>
  isDormant: ISettableObservable<boolean>
  backgroundTaskCount: ISettableObservable<number>
  isReplayingHistory: ISettableObservable<boolean>
  sessionIdOnAgent: ISettableObservable<string | undefined>
  imageSupported: ISettableObservable<boolean>
  forkSupported: ISettableObservable<boolean>
  rewindSupported: ISettableObservable<boolean>
  mcpServerSelection: ISettableObservable<readonly string[] | null>
  mcpServers: ISettableObservable<readonly AcpMcpServerStatus[]>
  requestProcessRestart: ReturnType<typeof vi.fn>
}

function makeSession(
  id: string,
  options: {
    durableId?: string
    title?: string
    readOnly?: boolean
    authority?: string
    cwd?: string
    agentId?: string
    forkSupported?: boolean
    rewindSupported?: boolean
    mcpSelection?: readonly string[] | null
    mcpStatuses?: readonly AcpMcpServerStatus[]
    isReconnecting?: boolean
  } = {},
): FakeSessionHarness {
  const timeline = observableValue<readonly TimelineItem[]>('test.timeline', [])
  const messages = observableValue<readonly AcpMessage[]>('test.messages', [])
  const toolCalls = observableValue<readonly AcpToolCall[]>('test.toolCalls', [])
  const plan = observableValue<readonly AcpPlanEntry[]>('test.plan', [])
  const configOptions = observableValue<readonly SessionConfigOption[]>('test.config', [])
  const availableCommands = observableValue<readonly AvailableCommand[]>(
    'test.availableCommands',
    [],
  )
  const usage = observableValue<AcpUsage | undefined>('test.usage', undefined)
  const pendingPermission = observableValue<AcpPendingPermission | undefined>(
    'test.permission',
    undefined,
  )
  const pendingElicitation = observableValue<AcpPendingElicitation | undefined>(
    'test.elicitation',
    undefined,
  )
  const status = observableValue<'idle' | 'connecting' | 'running' | 'errored' | 'closed'>(
    'test.status',
    'idle',
  )
  const isDormant = observableValue<boolean>('test.dormant', false)
  const backgroundTaskCount = observableValue<number>('test.bg', 0)
  const isReplayingHistory = observableValue<boolean>('test.replay', false)
  const sessionIdOnAgent = observableValue<string | undefined>('test.durable', options.durableId)
  const imageSupported = observableValue<boolean>('test.imageSupported', true)
  const forkSupported = observableValue<boolean>('test.fork', options.forkSupported ?? false)
  const rewindSupported = observableValue<boolean>('test.rewind', options.rewindSupported ?? false)
  const mcpServerSelection = observableValue<readonly string[] | null>(
    'test.mcpSelection',
    options.mcpSelection ?? null,
  )
  const mcpServers = observableValue<readonly AcpMcpServerStatus[]>(
    'test.mcpServers',
    options.mcpStatuses ?? [],
  )
  const requestProcessRestart = vi.fn()
  const settleEmitter = new Emitter<AcpPermissionSettledEvent>()
  const session = {
    id,
    agentId: options.agentId ?? 'fake',
    title: options.title ?? `Session ${id}`,
    cwd: options.cwd ?? '/workspace/demo',
    authority: options.authority,
    readOnly: options.readOnly ?? false,
    timeline,
    messages,
    toolCalls,
    plan,
    configOptions,
    availableCommands,
    usage,
    pendingPermission,
    pendingElicitation,
    settlePermission: (event: AcpPermissionSettledEvent) => settleEmitter.fire(event),
    status,
    isDormant,
    backgroundTaskCount,
    isReplayingHistory,
    sessionIdOnAgent,
    imageSupported,
    forkSupported,
    rewindSupported,
    mcpServerSelection,
    mcpServers,
    isReconnecting: options.isReconnecting ?? false,
    requestProcessRestart,
    onDidSettlePermission: settleEmitter.event,
    onDidSettleElicitation: Event.None,
    sendPrompt: vi.fn(async () => {}),
    cancelTurn: vi.fn(async () => {}),
    setConfigOption: vi.fn(async () => {}),
    renameTitle: vi.fn(),
  } as unknown as IAcpSession
  return {
    session,
    timeline,
    messages,
    toolCalls,
    plan,
    configOptions,
    availableCommands,
    usage,
    pendingPermission,
    pendingElicitation,
    settlePermission: (event: AcpPermissionSettledEvent) => settleEmitter.fire(event),
    status,
    isDormant,
    backgroundTaskCount,
    isReplayingHistory,
    sessionIdOnAgent,
    imageSupported,
    forkSupported,
    rewindSupported,
    mcpServerSelection,
    mcpServers,
    requestProcessRestart,
  }
}

function message(id: string, text: string, streaming = false): AcpMessage {
  return { id, role: 'agent', text, blocks: [{ type: 'text', text }], streaming }
}

function userMessage(
  id: string,
  messageId: string,
  text: string,
  options: { autoRetry?: boolean } = {},
): AcpMessage {
  return {
    id,
    role: 'user',
    text,
    blocks: [{ type: 'text', text }],
    streaming: false,
    messageId,
    ...(options.autoRetry === true ? { autoRetry: true as const } : {}),
  }
}

function messageItem(id: string, text: string, streaming = false): TimelineItem {
  return { kind: 'message', id, message: message(id, text, streaming) }
}

function toolCall(overrides: Partial<AcpToolCall> = {}): AcpToolCall {
  return {
    id: 'tool-1',
    title: 'Edit file',
    kind: 'edit',
    status: 'completed',
    text: 'applied',
    blocks: [],
    diffs: [],
    ...overrides,
  }
}

function makeHarness(filesOverrides: Partial<IFileService> = {}): {
  service: MobileBridgeService
  sessions: ISettableObservable<readonly IAcpSession[]>
  history: ISettableObservable<readonly AcpSessionHistoryEntry[]>
  events: MobileBridgeEvent[]
  created: ReturnType<typeof vi.fn>
  sessionService: IAcpSessionService
  historyService: IAcpSessionHistoryService
  forkSession: ReturnType<typeof vi.fn>
  rewindSession: ReturnType<typeof vi.fn>
  forkSideTask: ReturnType<typeof vi.fn>
  resumeSession: ReturnType<typeof vi.fn>
  workspace: { current: { folder: URI; name: string } | null }
  userSettings: { whenInitialized: Promise<void> }
  scmSourceControls: ISettableObservable<readonly IScmSourceControlModel[]>
  files: IFileService
  fileSearch: IFileSearchService
  docs: IDocsService
  commands: ICommandService
  chatContext: IChatContextService
  chatProviders: Array<{ handle: number; provider: Record<string, unknown> }>
  delivery: ISessionDeliveryService
  deliveryChanges: Emitter<SessionDeliveryChange>
  claudeSettings: ClaudeSettings
  claudeRead: ReturnType<typeof vi.fn>
  claudePatch: ReturnType<typeof vi.fn>
  mcpServerDefinitions: ISettableObservable<readonly McpServerDefinition[]>
  setSessionMcpServers: ReturnType<typeof vi.fn>
  add(session: FakeSessionHarness): void
  remove(id: string): void
} {
  const sessions = observableValue<readonly IAcpSession[]>('test.sessions', [])
  const history = observableValue<readonly AcpSessionHistoryEntry[]>('test.history', [])
  const deliveryChanges = new Emitter<SessionDeliveryChange>()
  const live = new Map<string, IAcpSession>()
  const created = vi.fn()
  const forkSession = vi.fn()
  const rewindSession = vi.fn()
  const forkSideTask = vi.fn()
  const resumeSession = vi.fn()
  const mcpServerDefinitions = observableValue<readonly McpServerDefinition[]>('test.mcpPool', [])
  const setSessionMcpServers = vi.fn()
  const sessionService = {
    sessions,
    getById: (id: string) =>
      live.get(id) ?? [...live.values()].find((session) => session.sessionIdOnAgent.get() === id),
    createSession: vi.fn(async () => created()),
    closeSession: vi.fn(async () => {}),
    deleteOnAgent: vi.fn(async () => {}),
    forkSession,
    rewindSession,
    forkSideTask,
    resumeSession,
    mcpServerDefinitions,
    refreshMcpServerDefinitions: vi.fn(async () => {}),
    setSessionMcpServers,
  } as unknown as IAcpSessionService
  const historyService = {
    entries: history,
    initialize: vi.fn(async () => {}),
    get: (id: string) => history.get().find((entry) => entry.id === id),
    list: () => history.get(),
    removeDeleted: vi.fn(),
  } as unknown as IAcpSessionHistoryService
  const registry = {
    get: (id: string) => {
      if (id !== 'fake' && id !== 'other') throw new Error('unknown agent')
      return { id, name: id === 'fake' ? 'Fake Agent' : 'Other Agent' }
    },
    list: () => [
      { id: 'fake', name: 'Fake Agent' },
      { id: 'other', name: 'Other Agent' },
    ],
    defaultAgentId: () => 'fake',
  } as unknown as IAcpAgentRegistry
  const loggerService = { createLogger: () => NULL_LOGGER } as unknown as ILoggerService
  const claudeSettings: ClaudeSettings = {}
  const claudeRead = vi.fn(async () => claudeSettings)
  const claudePatch = vi.fn(async (patch: ClaudeSettingsPatch) => {
    const env = { ...(claudeSettings.env ?? {}) }
    for (const [key, value] of Object.entries(patch.env ?? {})) {
      if (value === null) delete env[key]
      else env[key] = value
    }
    claudeSettings.env = env
  })
  const claudeConfig = {
    read: claudeRead,
    patch: claudePatch,
    onDidChangeConfig: Event.None,
  } as unknown as IClaudeConfigService
  const workspace = { current: null } as unknown as IWorkspaceService & {
    current: { folder: URI; name: string } | null
  }
  const editorGroups = { groups: [] } as unknown as IEditorGroupsService
  const userSettings = {
    whenInitialized: Promise.resolve(),
  } as IUserSettingsSyncService
  const scmSourceControls = observableValue<readonly IScmSourceControlModel[]>(
    'test.scmSourceControls',
    [],
  )
  const scm = { sourceControls: scmSourceControls } as unknown as IScmService
  const files = {
    stat: vi.fn(
      async (resource: URI): Promise<IFileStat> => ({
        resource,
        isFile: true,
        isDirectory: false,
        size: 3,
        mtime: 0,
      }),
    ),
    readFile: vi.fn(async () => new Uint8Array([1, 2, 3])),
    ...filesOverrides,
  } as unknown as IFileService
  const delivery = {
    initialize: vi.fn(async () => {}),
    onDidChange: deliveryChanges.event,
    getSummaryForSession: vi.fn(() => undefined),
    isAvailable: vi.fn(() => false),
    hasDeliverableChanges: vi.fn(() => false),
    refreshDeliverableChanges: vi.fn(async () => false),
    isDeliveryBusyForSession: vi.fn(() => false),
    isDeliveryBusyForCwd: vi.fn(() => false),
    preview: vi.fn(),
    start: vi.fn(),
    startInBackground: vi.fn(),
    confirmPush: vi.fn(),
    confirmPushInBackground: vi.fn(),
    retry: vi.fn(),
    undo: vi.fn(),
    openMainWorktree: vi.fn(),
    getContext: vi.fn(() => undefined),
    getRecord: vi.fn(() => undefined),
    getDetail: vi.fn(() => undefined),
    listActiveContexts: vi.fn(() => []),
  } as unknown as ISessionDeliveryService
  const branchPush = {
    preview: vi.fn(),
    push: vi.fn(),
  } as unknown as ISessionBranchPushService
  const fileSearch = {
    search: vi.fn(
      async (): Promise<IFileSearchComplete> => ({
        results: [],
        limitHit: false,
        filesWalked: 0,
        directoriesWalked: 0,
        durationMs: 0,
      }),
    ),
  } as unknown as IFileSearchService
  const exclude = {
    getDirNameIgnores: () => [],
    getSearchExcludeGlobs: () => [],
    getUseIgnoreFiles: () => false,
  } as unknown as IExcludeService
  const langFeatures = {} as unknown as ILanguageFeaturesService
  const docs = {
    getDocs: vi.fn(async () => ({ user: {}, extensionDev: {} })),
    getDocsRoot: vi.fn(async (category: DocCategory) => `/docs/${category}`),
  } as unknown as IDocsService
  const commands = {
    executeCommand: vi.fn(async () => undefined),
  } as unknown as ICommandService
  const chatProviders: Array<{ handle: number; provider: Record<string, unknown> }> = []
  const chatContext = {
    getProviders: () => chatProviders,
    resolveItem: vi.fn(async () => undefined),
    resolveItemOrThrow: vi.fn(async () => undefined),
  } as unknown as IChatContextService
  const service = new MobileBridgeService(
    sessionService,
    historyService,
    registry,
    workspace,
    new UriIdentityService(normalizePlatform('linux')),
    editorGroups,
    userSettings,
    scm,
    files,
    delivery,
    branchPush,
    fileSearch,
    exclude,
    langFeatures,
    docs,
    commands,
    chatContext,
    claudeConfig,
    loggerService,
  )
  const events: MobileBridgeEvent[] = []
  service.onDidChange((event) => events.push(event))
  return {
    service,
    sessions,
    history,
    events,
    created,
    sessionService,
    historyService,
    forkSession,
    rewindSession,
    forkSideTask,
    resumeSession,
    workspace: workspace as unknown as { current: { folder: URI; name: string } | null },
    userSettings,
    scmSourceControls,
    files,
    fileSearch,
    docs,
    commands,
    chatContext,
    chatProviders,
    delivery,
    deliveryChanges,
    claudeSettings,
    claudeRead,
    claudePatch,
    mcpServerDefinitions,
    setSessionMcpServers,
    add(session) {
      live.set(session.session.id, session.session)
      sessions.set([...sessions.get(), session.session], undefined)
    },
    remove(id) {
      live.delete(id)
      const next = sessions.get().filter((session) => session.id !== id)
      if (next.length === 0) sessions.set([], undefined)
      else sessions.set([...next], undefined)
    },
  }
}

async function flush(ms = MOBILE_BRIDGE_THROTTLE_MS + 10): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function makeHistoryEntry(
  id: string,
  overrides: Partial<AcpSessionHistoryEntry> = {},
): AcpSessionHistoryEntry {
  return {
    id,
    agentId: 'fake',
    sessionIdOnAgent: id,
    title: `Session ${id}`,
    createdAt: 1,
    lastUsedAt: 1,
    ...overrides,
  } as unknown as AcpSessionHistoryEntry
}

describe('MobileBridgeService', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    AcpPromptDraftCache._resetForTests()
  })

  it('publishes a locally edited draft after the debounce window', async () => {
    const harness = makeHarness()
    harness.add(makeSession('s1'))
    await harness.service.startStreaming()

    AcpPromptDraftCache.save('s1', { text: 'hi', caret: 2 })
    await vi.advanceTimersByTimeAsync(MOBILE_DRAFT_THROTTLE_MS)

    expect(harness.events.filter((event) => event.kind === 'draft')).toStrictEqual([
      { kind: 'draft', localId: 's1', draft: { text: 'hi', images: [] } },
    ])
  })

  it('applies a phone draft to the cache without echoing it back', async () => {
    const harness = makeHarness()
    harness.add(makeSession('s1'))
    await harness.service.startStreaming()

    const result = await harness.service.applyDraft('s1', {
      text: 'from phone',
      images: [],
    })
    expect(result).toStrictEqual({ ok: true, value: undefined })
    expect(AcpPromptDraftCache.load('s1')?.text).toBe('from phone')
    // The remote caret is gone; an empty local buffer starts at the end.
    expect(AcpPromptDraftCache.load('s1')?.caret).toBe(10)

    await vi.advanceTimersByTimeAsync(MOBILE_DRAFT_THROTTLE_MS)
    expect(harness.events.filter((event) => event.kind === 'draft')).toStrictEqual([])
  })

  it('keeps a queued local publish when a phone draft arrives first', async () => {
    const harness = makeHarness()
    harness.add(makeSession('s1'))
    await harness.service.startStreaming()

    AcpPromptDraftCache.save('s1', { text: 'local edit', caret: 11 })
    await harness.service.applyDraft('s1', { text: 'from phone', images: [] })
    await harness.service.noteDraftRevision('s1', 4)
    await vi.advanceTimersByTimeAsync(MOBILE_DRAFT_THROTTLE_MS)

    expect(harness.events.filter((event) => event.kind === 'draft')).toStrictEqual([
      { kind: 'draft', localId: 's1', draft: { text: 'local edit', images: [] } },
    ])

    // The hub assigned the local publish a higher revision than the phone
    // update, so the deferred phone text must not overwrite it.
    await harness.service.ackDraftRevision('s1', 5)
    expect(AcpPromptDraftCache.load('s1')?.text).toBe('local edit')
  })

  it('keeps a queued local publish when a phone attachment lands first', async () => {
    const harness = makeHarness()
    harness.add(makeSession('s1'))
    await harness.service.startStreaming()

    AcpPromptDraftCache.save('s1', { text: 'local text', caret: 10 })
    await harness.service.attachDraftAttachments('s1', [
      {
        kind: 'image',
        id: 'img-1',
        name: 'shot.png',
        mimeType: 'image/png',
        byteSize: 3,
        dataBase64: 'AQID',
      },
    ])
    await vi.advanceTimersByTimeAsync(MOBILE_DRAFT_THROTTLE_MS)

    expect(harness.events.filter((event) => event.kind === 'draft')).toStrictEqual([
      {
        kind: 'draft',
        localId: 's1',
        draft: {
          text: 'local text',
          images: [
            { id: 'img-1', source: 'pc', mimeType: 'image/png', byteSize: 3, name: 'shot.png' },
          ],
        },
      },
    ])
  })

  it('applies a deferred phone draft when it outranks the local publish', async () => {
    const harness = makeHarness()
    harness.add(makeSession('s1'))
    await harness.service.startStreaming()

    AcpPromptDraftCache.save('s1', { text: 'local edit', caret: 11 })
    await harness.service.applyDraft('s1', { text: 'from phone', images: [] })
    await vi.advanceTimersByTimeAsync(MOBILE_DRAFT_THROTTLE_MS)
    await harness.service.noteDraftRevision('s1', 6)
    expect(AcpPromptDraftCache.load('s1')?.text).toBe('local edit')

    await harness.service.ackDraftRevision('s1', 5)

    expect(AcpPromptDraftCache.load('s1')?.text).toBe('from phone')
  })

  it('settles a deferred phone draft when the local ack never arrives', async () => {
    const harness = makeHarness()
    harness.add(makeSession('s1'))
    await harness.service.startStreaming()

    AcpPromptDraftCache.save('s1', { text: 'local edit', caret: 11 })
    await harness.service.applyDraft('s1', { text: 'from phone', images: [] })
    await vi.advanceTimersByTimeAsync(MOBILE_DRAFT_THROTTLE_MS)
    await harness.service.noteDraftRevision('s1', 6)

    await vi.advanceTimersByTimeAsync(MOBILE_DRAFT_ACK_TIMEOUT_MS)

    expect(AcpPromptDraftCache.load('s1')?.text).toBe('from phone')
  })

  it('publishes a pasted picture immediately instead of behind the typing debounce', async () => {
    const harness = makeHarness()
    harness.add(makeSession('s1'))
    await harness.service.startStreaming()

    AcpPromptDraftCache.save('s1', { text: 'hi', caret: 2 })
    await vi.advanceTimersByTimeAsync(MOBILE_DRAFT_THROTTLE_MS)
    expect(harness.events.filter((event) => event.kind === 'draft')).toHaveLength(1)

    AcpPromptDraftCache.save('s1', {
      text: 'hi',
      caret: 2,
      images: [{ id: 'img-1', mimeType: 'image/png', dataBase64: 'AQID', byteSize: 3 } as never],
    })

    expect(harness.events.filter((event) => event.kind === 'draft')).toStrictEqual([
      { kind: 'draft', localId: 's1', draft: { text: 'hi', images: [] } },
      {
        kind: 'draft',
        localId: 's1',
        draft: {
          text: 'hi',
          images: [{ id: 'img-1', source: 'pc', mimeType: 'image/png', byteSize: 3 }],
        },
      },
    ])
  })

  it('rejects a phone draft for a read-only session', async () => {
    const harness = makeHarness()
    harness.add(makeSession('s1', { readOnly: true }))

    const result = await harness.service.applyDraft('s1', { text: 'nope', images: [] })

    expect(result).toMatchObject({ ok: false, code: 'session_read_only' })
    expect(AcpPromptDraftCache.load('s1')).toBeUndefined()
  })

  it('serves bytes for a picture pasted on the PC', async () => {
    const harness = makeHarness()
    harness.add(makeSession('s1'))
    AcpPromptDraftCache.save('s1', {
      text: '',
      images: [
        {
          id: 'img-1',
          mimeType: 'image/png',
          dataBase64: 'AQID',
          byteSize: 3,
        },
      ],
    })

    const image = await harness.service.getDraftImage('s1', 'img-1')

    expect(image?.mimeType).toBe('image/png')
    expect([...image!.bytes]).toEqual([1, 2, 3])
    await expect(harness.service.getDraftImage('s1', 'missing')).resolves.toBeUndefined()
  })

  it('materializes phone attachments into the draft and resolves them for sending', async () => {
    const harness = makeHarness()
    harness.add(makeSession('s1'))

    await harness.service.attachDraftAttachments('s1', [
      {
        kind: 'image',
        id: 'img-1',
        name: 'shot.png',
        mimeType: 'image/png',
        byteSize: 3,
        dataBase64: 'AQID',
      },
      {
        kind: 'file',
        id: 'file-1',
        name: 'notes.txt',
        mimeType: 'text/plain',
        byteSize: 7,
        uri: 'file:///tmp/notes.txt',
      },
    ])

    const draft = AcpPromptDraftCache.load('s1')
    expect(draft?.images?.[0]).toMatchObject({ id: 'img-1', attachmentId: 'img-1' })
    expect(draft?.files?.[0]).toMatchObject({ id: 'file-1', uri: 'file:///tmp/notes.txt' })

    const resolved = await harness.service.resolveDraftAttachments('s1', ['img-1'], ['file-1'])
    expect(resolved).toStrictEqual({
      ok: true,
      value: [
        {
          kind: 'image',
          id: 'img-1',
          name: 'shot.png',
          mimeType: 'image/png',
          byteSize: 3,
          dataBase64: 'AQID',
        },
        {
          kind: 'file',
          id: 'file-1',
          name: 'notes.txt',
          mimeType: 'text/plain',
          byteSize: 7,
          uri: 'file:///tmp/notes.txt',
        },
      ],
    })

    await expect(
      harness.service.resolveDraftAttachments('s1', ['img-1', 'missing']),
    ).resolves.toMatchObject({ ok: false, code: 'attachment_not_found' })
  })

  it('clears the shared draft on request', async () => {
    const harness = makeHarness()
    harness.add(makeSession('s1'))
    AcpPromptDraftCache.save('s1', { text: 'draft' })

    await expect(harness.service.clearDraft('s1')).resolves.toEqual({ ok: true, value: undefined })
    expect(AcpPromptDraftCache.load('s1')).toBeUndefined()
  })

  it('does no work before startStreaming', async () => {
    const harness = makeHarness()
    const first = makeSession('s1', { durableId: 'd1' })
    harness.add(first)

    first.timeline.set([messageItem('m1', 'before')], undefined)
    first.status.set('running', undefined)
    await flush(300)

    expect(harness.events).toStrictEqual([])
  })

  it('builds a read-only snapshot with history title and projected timeline', async () => {
    const harness = makeHarness()
    const first = makeSession('s1', { durableId: 'd1' })
    harness.history.set(
      [{ id: 'd1', title: 'History title' } as unknown as AcpSessionHistoryEntry],
      undefined,
    )
    harness.add(first)
    first.status.set('running', undefined)
    first.sessionIdOnAgent.set('d1', undefined)
    first.timeline.set(
      [
        messageItem('m1', 'hello'),
        {
          kind: 'toolCall',
          id: 'tool-1',
          call: toolCall({
            text: 'diff body',
            diffs: [{ path: '/workspace/a.ts', oldText: 'a\nb', newText: 'a\nc' }],
            locations: [{ path: '/workspace/a.ts', line: 2 }],
          }),
        },
      ],
      undefined,
    )
    first.plan.set([{ content: 'Step', status: 'in_progress' }], undefined)
    first.configOptions.set(
      [
        {
          id: 'model',
          name: 'Model',
          type: 'select',
          currentValue: 'm1',
          options: [{ value: 'm1', name: 'Model One' }],
        } as unknown as SessionConfigOption,
      ],
      undefined,
    )
    first.usage.set({ used: 10, size: 100, cost: { amount: 0.1, currency: 'USD' } }, undefined)
    first.availableCommands.set(
      [
        {
          name: '/compact',
          description: 'Compact  the conversation',
          input: { hint: 'instructions' },
        },
        { name: 'status', description: 'Show status' },
      ] as unknown as AvailableCommand[],
      undefined,
    )

    const snapshot = await harness.service.getSnapshot('s1')

    expect(snapshot?.summary).toMatchObject({
      localId: 's1',
      durableId: 'd1',
      agentId: 'fake',
      agentName: 'Fake Agent',
      title: 'History title',
      status: 'running',
      displayStatus: 'running',
      bucket: 'in_progress',
      cwd: '/workspace/demo',
      readOnly: false,
      hasPendingPermission: false,
      hasPendingElicitation: false,
      backgroundTaskCount: 0,
    })
    expect(snapshot?.timeline[0]).toStrictEqual({
      kind: 'message',
      id: 'm1',
      role: 'agent',
      text: 'hello',
      streaming: false,
    })
    expect(snapshot?.timeline[1]).toMatchObject({
      kind: 'toolCall',
      id: 'tool-1',
      toolKind: 'edit',
      hasDetail: true,
      preview: 'diff body',
      diffs: [{ path: '/workspace/a.ts', added: 1, removed: 1 }],
      locations: [{ path: '/workspace/a.ts', line: 2 }],
    })
    expect(snapshot?.plan).toStrictEqual([{ content: 'Step', status: 'in_progress' }])
    expect(snapshot?.configOptions).toStrictEqual([
      {
        id: 'model',
        name: 'Model',
        type: 'select',
        currentValue: 'Model One',
        options: [{ value: 'm1', label: 'Model One' }],
      },
    ])
    expect(snapshot?.usage).toStrictEqual({
      used: 10,
      size: 100,
      cost: { amount: 0.1, currency: 'USD' },
    })
    expect(snapshot?.availableCommands).toStrictEqual([
      {
        name: 'compact',
        description: 'Compact the conversation',
        inputHint: 'instructions',
      },
      { name: 'status', description: 'Show status' },
    ])
  })

  it('streams command-list changes once and skips identical projections', async () => {
    const harness = makeHarness()
    const first = makeSession('s1')
    harness.add(first)
    await harness.service.startStreaming()
    await flush()

    const commands = [
      { name: 'compact', description: 'Compact the conversation' },
    ] as unknown as AvailableCommand[]
    first.availableCommands.set(commands, undefined)
    await flush()

    const commandEvents = harness.events.flatMap((event) =>
      event.kind === 'session_delta'
        ? event.events.filter((delta) => delta.type === 'available_commands_snapshot')
        : [],
    )
    expect(commandEvents).toStrictEqual([
      {
        type: 'available_commands_snapshot',
        commands: [{ name: 'compact', description: 'Compact the conversation' }],
      },
    ])

    first.availableCommands.set([...commands], undefined)
    await flush()
    expect(
      harness.events.filter(
        (event) =>
          event.kind === 'session_delta' &&
          event.events.some((delta) => delta.type === 'available_commands_snapshot'),
      ),
    ).toHaveLength(1)
  })

  it('clamps oversized projected fields so the snapshot passes protocol validation', async () => {
    const harness = makeHarness()
    const first = makeSession('s1')
    harness.add(first)
    const long = 'x'.repeat(2_000)
    const call = toolCall({ title: long, text: long })
    first.timeline.set([{ kind: 'toolCall', id: call.id, call }], undefined)

    const snapshot = await harness.service.getSnapshot('s1')
    const item = snapshot?.timeline[0]
    expect(item?.kind).toBe('toolCall')
    if (item?.kind !== 'toolCall') throw new Error('expected a tool call')
    expect(item.title.length).toBe(MAX_TITLE_LENGTH)

    const { summary, draft: bridgeDraft, ...wireSnapshot } = snapshot!
    expect(bridgeDraft).toBeUndefined()
    const { localId, durableId, ...wireSummary } = summary
    const frame: SessionSnapshotFrame = {
      type: 'session_snapshot',
      seq: 1,
      session: {
        seq: 1,
        ...wireSnapshot,
        summary: {
          ...wireSummary,
          ref: {
            windowId: 1,
            localId,
            ...(durableId !== undefined ? { durableId } : {}),
          },
          workspaceName: 'demo',
        },
      },
    }
    const parsed = parseServerFrame(serializeFrame(frame))
    expect(parsed.ok ? 'ok' : parsed.error.message).toBe('ok')
  })

  it('reports session activity time instead of the moment the snapshot was projected', async () => {
    const harness = makeHarness()
    const first = makeSession('s1', { durableId: 'd1' })
    harness.history.set(
      [
        {
          id: 'd1',
          title: 'History title',
          lastUsedAt: 1_700_000_000_000,
        } as unknown as AcpSessionHistoryEntry,
      ],
      undefined,
    )
    harness.add(first)

    await expect(harness.service.listSessions()).resolves.toMatchObject([
      { localId: 's1', updatedAt: 1_700_000_000_000 },
    ])

    // A phone (re)subscribing later must not relabel the same row as "just now".
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    const snapshot = await harness.service.getSnapshot('s1')
    expect(snapshot?.summary.updatedAt).toBe(1_700_000_000_000)
  })

  it('streams a new timeline item and suffix-only message updates', async () => {
    const harness = makeHarness()
    const first = makeSession('s1')
    harness.add(first)
    await harness.service.startStreaming()
    await flush()

    first.timeline.set([messageItem('m1', 'hello', true)], undefined)
    await flush()
    const added = harness.events.find(
      (event): event is Extract<MobileBridgeEvent, { kind: 'session_delta' }> =>
        event.kind === 'session_delta' &&
        event.events.some((e) => e.type === 'timeline_item_added'),
    )
    expect(added?.events).toContainEqual({
      type: 'timeline_item_added',
      item: { kind: 'message', id: 'm1', role: 'agent', text: 'hello', streaming: true },
    })

    harness.events.length = 0
    first.timeline.set([messageItem('m1', 'hello world', true)], undefined)
    await flush()
    const upsert = harness.events
      .filter(
        (event): event is Extract<MobileBridgeEvent, { kind: 'session_delta' }> =>
          event.kind === 'session_delta',
      )
      .flatMap((event) => event.events)
      .find((event) => event.type === 'message_upsert')
    expect(upsert).toStrictEqual({
      type: 'message_upsert',
      id: 'm1',
      role: 'agent',
      streaming: true,
      textAppend: ' world',
    })
  })

  it('replaces text when the new text is not an extension of the old one', async () => {
    const harness = makeHarness()
    const first = makeSession('s1')
    harness.add(first)
    await harness.service.startStreaming()
    first.timeline.set([messageItem('m1', 'original text')], undefined)
    await flush()
    harness.events.length = 0

    first.timeline.set([messageItem('m1', 'rewound')], undefined)
    await flush()
    const events = harness.events
      .filter(
        (event): event is Extract<MobileBridgeEvent, { kind: 'session_delta' }> =>
          event.kind === 'session_delta',
      )
      .flatMap((event) => event.events)
    expect(events).toContainEqual({
      type: 'message_upsert',
      id: 'm1',
      role: 'agent',
      streaming: false,
      textReplace: 'rewound',
    })
  })

  it('emits tool-call upserts with preview and diff statistics', async () => {
    const harness = makeHarness()
    const first = makeSession('s1')
    harness.add(first)
    await harness.service.startStreaming()
    first.toolCalls.set([toolCall()], undefined)
    first.timeline.set([{ kind: 'toolCall', id: 'tool-1', call: toolCall() }], undefined)
    await flush()
    harness.events.length = 0

    first.toolCalls.set(
      [
        toolCall({
          status: 'in_progress',
          text: 'body',
          diffs: [{ path: '/workspace/a.ts', oldText: 'one\ntwo', newText: 'one\nthree' }],
        }),
      ],
      undefined,
    )
    first.timeline.set(
      [
        {
          kind: 'toolCall',
          id: 'tool-1',
          call: toolCall({
            status: 'in_progress',
            text: 'body',
            diffs: [{ path: '/workspace/a.ts', oldText: 'one\ntwo', newText: 'one\nthree' }],
          }),
        },
      ],
      undefined,
    )
    await flush()

    const upsert = harness.events
      .filter(
        (event): event is Extract<MobileBridgeEvent, { kind: 'session_delta' }> =>
          event.kind === 'session_delta',
      )
      .flatMap((event) => event.events)
      .find((event) => event.type === 'tool_call_upsert')
    expect(upsert).toMatchObject({
      type: 'tool_call_upsert',
      item: {
        kind: 'toolCall',
        id: 'tool-1',
        status: 'in_progress',
        preview: 'body',
        diffs: [{ path: '/workspace/a.ts', added: 1, removed: 1 }],
      },
    })
  })

  it('emits permission upserts and clears them', async () => {
    const harness = makeHarness()
    const first = makeSession('s1')
    harness.add(first)
    await harness.service.startStreaming()
    await flush()
    harness.events.length = 0

    const permission: AcpPendingPermission = {
      requestId: 'req-1',
      toolCallId: 'tool-1',
      title: 'Run command',
      options: [{ optionId: 'allow', name: 'Allow' }],
      resolve: () => {},
      cancel: () => {},
      resolveWithSource: () => {},
      cancelWithSource: () => {},
    }
    first.pendingPermission.set(permission, undefined)
    await flush()
    const upsert = harness.events
      .filter(
        (event): event is Extract<MobileBridgeEvent, { kind: 'session_delta' }> =>
          event.kind === 'session_delta',
      )
      .flatMap((event) => event.events)
    expect(upsert[0]).toMatchObject({ type: 'permission_upsert' })
    expect(upsert.at(-1)).toMatchObject({
      type: 'summary_changed',
      summary: { hasPendingPermission: true, displayStatus: 'ask', bucket: 'input_needed' },
    })

    harness.events.length = 0
    first.pendingPermission.set(undefined, undefined)
    await flush()
    const cleared = harness.events
      .filter(
        (event): event is Extract<MobileBridgeEvent, { kind: 'session_delta' }> =>
          event.kind === 'session_delta',
      )
      .flatMap((event) => event.events)
    expect(cleared[0]).toStrictEqual({
      type: 'permission_cleared',
      requestId: 'req-1',
      reason: 'cancelled',
      source: 'pc',
    })
  })

  it('coalesces rapid updates into one delta batch', async () => {
    const harness = makeHarness()
    const first = makeSession('s1')
    harness.add(first)
    await harness.service.startStreaming()
    first.timeline.set([messageItem('m1', 'a')], undefined)
    await flush()
    harness.events.length = 0

    first.timeline.set([messageItem('m1', 'ab')], undefined)
    await vi.advanceTimersByTimeAsync(10)
    first.timeline.set([messageItem('m1', 'abc')], undefined)
    await vi.advanceTimersByTimeAsync(10)
    first.timeline.set([messageItem('m1', 'abcd')], undefined)
    await flush()

    const deltas = harness.events.filter(
      (event): event is Extract<MobileBridgeEvent, { kind: 'session_delta' }> =>
        event.kind === 'session_delta',
    )
    expect(deltas).toHaveLength(1)
    expect(deltas[0]?.events).toContainEqual({
      type: 'message_upsert',
      id: 'm1',
      role: 'agent',
      streaming: false,
      textAppend: 'bcd',
    })
  })

  it('slows the throttle window for a single large message delta', async () => {
    const harness = makeHarness()
    const first = makeSession('s1')
    harness.add(first)
    await harness.service.startStreaming()
    first.timeline.set([messageItem('m1', 'a')], undefined)
    await flush()
    harness.events.length = 0

    first.timeline.set([messageItem('m1', `a${'x'.repeat(70 * 1024)}`)], undefined)
    await vi.advanceTimersByTimeAsync(MOBILE_BRIDGE_THROTTLE_MS + 10)
    expect(harness.events).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(MOBILE_BRIDGE_LARGE_THROTTLE_MS)
    expect(harness.events.length).toBeGreaterThan(0)
  })

  it('publishes inbox removals when a session disappears', async () => {
    const harness = makeHarness()
    const first = makeSession('s1', { durableId: 'd1' })
    harness.add(first)
    await harness.service.startStreaming()
    await flush()
    harness.events.length = 0

    harness.remove('s1')
    await vi.advanceTimersByTimeAsync(5)

    expect(harness.events).toContainEqual({
      kind: 'inbox',
      upserts: [],
      removes: [{ localId: 's1', durableId: 'd1' }],
    })
  })

  it('returns full tool-call detail and undefined for unknown ids', async () => {
    const harness = makeHarness()
    const first = makeSession('s1')
    harness.add(first)
    const call = toolCall({
      text: 'full body',
      diffs: [{ path: '/workspace/a.ts', oldText: 'o', newText: 'n' }],
      locations: [{ path: '/workspace/a.ts', line: 1 }],
    })
    first.toolCalls.set([call], undefined)

    await expect(harness.service.getToolCallDetail('s1', 'tool-1')).resolves.toStrictEqual({
      id: 'tool-1',
      title: 'Edit file',
      kind: 'edit',
      status: 'completed',
      text: 'full body',
      diffs: [{ path: '/workspace/a.ts', oldText: 'o', newText: 'n' }],
      locations: [{ path: '/workspace/a.ts', line: 1 }],
    })
    await expect(harness.service.getToolCallDetail('s1', 'missing')).resolves.toBeUndefined()
    await expect(harness.service.getToolCallDetail('missing', 'tool-1')).resolves.toBeUndefined()
  })
})

describe('MobileBridgeService commands', () => {
  function makePermission(
    requestId: string,
    options: AcpPendingPermission['options'],
    extra: Partial<AcpPendingPermission> = {},
  ): AcpPendingPermission {
    return {
      requestId,
      toolCallId: 'tool-1',
      title: 'Run command',
      options,
      resolve: vi.fn(),
      cancel: vi.fn(),
      resolveWithSource: vi.fn(),
      cancelWithSource: vi.fn(),
      ...extra,
    }
  }

  function makeElicitation(requestId: string): AcpPendingElicitation {
    return {
      requestId,
      request: {
        message: 'Name?',
        requestedSchema: { type: 'object', properties: {} },
      } as unknown as AcpPendingElicitation['request'],
      resolve: vi.fn(),
      cancel: vi.fn(),
      resolveWithSource: vi.fn(),
      cancelWithSource: vi.fn(),
    }
  }

  function callSpy<T extends (...args: never[]) => unknown>(session: IAcpSession, name: string): T {
    return (session as unknown as Record<string, T>)[name]!
  }

  function promptRefSourceControl(rootUri: string): IScmSourceControlModel {
    return {
      id: 'git',
      label: 'Git',
      rootUri,
      count: observableValue<number | undefined>('test.scmCount', 0),
      groups: observableValue('test.groups', []),
    } as unknown as IScmSourceControlModel
  }

  it('forwards prompt, cancel, rename and config commands to the session', async () => {
    const harness = makeHarness()
    const first = makeSession('s1')
    harness.add(first)
    first.configOptions.set(
      [
        {
          id: 'mode',
          name: 'Mode',
          type: 'select',
          currentValue: 'ask',
          options: [
            { value: 'ask', name: 'Ask' },
            { value: 'code', name: 'Code' },
          ],
        },
        { id: 'fast', name: 'Fast', type: 'boolean', currentValue: false },
      ] as unknown as SessionConfigOption[],
      undefined,
    )

    await expect(harness.service.sendPrompt('s1', 'hello')).resolves.toEqual({
      ok: true,
      value: undefined,
    })
    expect(callSpy<(...a: unknown[]) => unknown>(first.session, 'sendPrompt')).toHaveBeenCalledWith(
      'hello',
    )

    await expect(harness.service.cancelTurn('s1')).resolves.toEqual({ ok: true, value: undefined })
    expect(callSpy(first.session, 'cancelTurn')).toHaveBeenCalled()

    await expect(harness.service.renameSession('s1', 'New title')).resolves.toEqual({
      ok: true,
      value: undefined,
    })
    expect(callSpy(first.session, 'renameTitle')).toHaveBeenCalledWith('New title')

    await expect(harness.service.setConfigOption('s1', 'mode', 'code')).resolves.toEqual({
      ok: true,
      value: undefined,
    })
    await expect(harness.service.setConfigOption('s1', 'fast', true)).resolves.toEqual({
      ok: true,
      value: undefined,
    })
    expect(callSpy(first.session, 'setConfigOption')).toHaveBeenNthCalledWith(1, 'mode', 'code')
    expect(callSpy(first.session, 'setConfigOption')).toHaveBeenNthCalledWith(2, 'fast', true)
  })

  it('maps phone attachments to prompt images and file links', async () => {
    const harness = makeHarness()
    const first = makeSession('s1')
    harness.add(first)

    await expect(
      harness.service.sendPrompt('s1', '', [
        {
          kind: 'image',
          id: 'a1',
          name: 'shot.png',
          mimeType: 'image/png',
          byteSize: 3,
          dataBase64: 'AAA=',
        },
        {
          kind: 'file',
          id: 'a2',
          name: 'notes.txt',
          mimeType: 'text/plain',
          byteSize: 5,
          uri: 'file:///tmp/attachments/a2/notes.txt',
        },
      ]),
    ).resolves.toEqual({ ok: true, value: undefined })
    expect(callSpy(first.session, 'sendPrompt')).toHaveBeenCalledWith(
      '',
      undefined,
      undefined,
      [
        {
          id: 'a1',
          attachmentId: 'a1',
          mimeType: 'image/png',
          dataBase64: 'AAA=',
          byteSize: 3,
          name: 'shot.png',
        },
      ],
      [
        {
          id: 'a2',
          name: 'notes.txt',
          mimeType: 'text/plain',
          byteSize: 5,
          uri: 'file:///tmp/attachments/a2/notes.txt',
        },
      ],
    )
  })

  it('rejects image attachments when the agent does not accept images', async () => {
    const harness = makeHarness()
    const first = makeSession('s1')
    first.imageSupported.set(false, undefined)
    harness.add(first)

    await expect(
      harness.service.sendPrompt('s1', 'x', [
        {
          kind: 'image',
          id: 'a1',
          name: 'shot.png',
          mimeType: 'image/png',
          byteSize: 3,
          dataBase64: 'AAA=',
        },
      ]),
    ).resolves.toMatchObject({ ok: false, code: 'not_supported' })
    expect(callSpy(first.session, 'sendPrompt')).not.toHaveBeenCalled()
  })

  it('rejects file attachments for remote sessions', async () => {
    const harness = makeHarness()
    const remote = makeSession('s1', { authority: 'ssh-remote' })
    harness.add(remote)

    await expect(
      harness.service.sendPrompt('s1', 'x', [
        {
          kind: 'file',
          id: 'a2',
          name: 'notes.txt',
          mimeType: 'text/plain',
          byteSize: 5,
          uri: 'file:///tmp/attachments/a2/notes.txt',
        },
      ]),
    ).resolves.toMatchObject({ ok: false, code: 'forbidden_operation' })
    expect(callSpy(remote.session, 'sendPrompt')).not.toHaveBeenCalled()
  })

  it('routes prompt-ref completion through the session scope', async () => {
    invalidateMentionFileCache()
    const harness = makeHarness()
    harness.workspace.current = { folder: URI.file('/workspace/demo'), name: 'demo' }
    const first = makeSession('s1')
    harness.add(first)
    vi.mocked(harness.fileSearch.search).mockResolvedValueOnce({
      relPaths: ['src/a.ts', 'b.ts'],
      limitHit: false,
      filesWalked: 2,
      directoriesWalked: 1,
      durationMs: 1,
    })

    await expect(harness.service.searchPromptRefs('s1', '@', 'src', 10)).resolves.toEqual({
      ok: true,
      value: [{ kind: 'file', label: 'src/a.ts', uri: 'file:///workspace/demo/src/a.ts' }],
    })
    expect(harness.fileSearch.search).toHaveBeenCalledWith(
      expect.objectContaining({ root: URI.file('/workspace/demo'), matchAll: true }),
      expect.anything(),
    )
  })

  it('allows prompt-ref completion for read-only sessions but not without a workspace', async () => {
    invalidateMentionFileCache()
    const harness = makeHarness()
    harness.workspace.current = { folder: URI.file('/workspace/demo'), name: 'demo' }
    const readOnly = makeSession('ro', { readOnly: true })
    harness.add(readOnly)
    vi.mocked(harness.fileSearch.search).mockResolvedValueOnce({
      relPaths: ['a.ts'],
      limitHit: false,
      filesWalked: 1,
      directoriesWalked: 1,
      durationMs: 1,
    })

    await expect(harness.service.searchPromptRefs('ro', '@', 'a', 5)).resolves.toEqual({
      ok: true,
      value: [{ kind: 'file', label: 'a.ts', uri: 'file:///workspace/demo/a.ts' }],
    })
    await expect(harness.service.searchPromptRefs('missing', '@', 'a', 5)).resolves.toMatchObject({
      ok: false,
      code: 'session_not_found',
    })

    harness.workspace.current = null
    await expect(harness.service.searchPromptRefs('ro', '@', 'a', 5)).resolves.toEqual({
      ok: true,
      value: [],
    })
  })

  it('lists commit and extension entries in prompt-ref completion', async () => {
    const harness = makeHarness()
    harness.workspace.current = { folder: URI.file('/workspace/demo'), name: 'demo' }
    harness.add(makeSession('s1'))
    harness.scmSourceControls.set([promptRefSourceControl('/workspace/demo')], undefined)
    harness.chatProviders.push({
      handle: 7,
      provider: {
        label: 'Perforce CL',
        description: 'Pick a changelist',
        keywords: ['cl'],
      },
    })

    await expect(harness.service.searchPromptRefs('s1', '#', '', 20)).resolves.toEqual({
      ok: true,
      value: [
        {
          kind: 'commit',
          label: 'Git Commit…',
          uri: '',
          description: 'Pick a commit from history',
        },
        {
          kind: 'chatContext',
          label: 'Perforce CL',
          uri: '',
          chatContextHandle: 7,
          description: 'Pick a changelist',
        },
      ],
    })
  })

  it('resolves commit history for the phone, even for a read-only session', async () => {
    const harness = makeHarness()
    harness.workspace.current = { folder: URI.file('/workspace/demo'), name: 'demo' }
    harness.add(makeSession('ro', { readOnly: true }))
    harness.scmSourceControls.set([promptRefSourceControl('/workspace/demo')], undefined)
    const hash = 'a'.repeat(40)
    vi.mocked(harness.commands.executeCommand).mockImplementation((async (id: string) =>
      id === GitGraphCommands.getCommits
        ? {
            commits: [
              {
                hash,
                parents: [],
                author: 'Alice',
                email: 'alice@example.com',
                date: 1700000000,
                message: 'fix login',
                heads: [],
                tags: [],
                remotes: [],
                stash: null,
                worktrees: [],
              },
            ],
            head: hash,
            headName: 'main',
            moreAvailable: false,
            uncommittedChanges: 0,
          }
        : undefined) as never)

    const result = await harness.service.resolvePromptRef('ro', {
      kind: 'commit',
      query: '',
      limit: 50,
    })

    expect(harness.commands.executeCommand).toHaveBeenNthCalledWith(
      1,
      GitGraphCommands.setRepo,
      '/workspace/demo',
    )
    expect(result).toEqual({
      ok: true,
      value: {
        kind: 'commit',
        entries: [
          {
            kind: 'commit',
            label: 'aaaaaaa fix login',
            uri: URI.file('/workspace/demo').toString(),
            commitHash: hash,
            text: 'fix login',
            description: `Alice · ${relativeTime(1700000000 * 1000)}`,
          },
        ],
      },
    })
  })

  it('runs the extension picker for chatContext with the session directory', async () => {
    const harness = makeHarness()
    harness.workspace.current = { folder: URI.file('/workspace/demo'), name: 'demo' }
    harness.add(makeSession('s1', { cwd: '/workspace/demo/sub' }))
    harness.chatProviders.push({
      handle: 7,
      provider: { label: 'Perforce CL', description: 'Pick a changelist', keywords: ['cl'] },
    })
    vi.mocked(harness.chatContext.resolveItemOrThrow).mockResolvedValue({
      label: 'CL 1',
      text: 'body',
    })

    const result = await harness.service.resolvePromptRef('s1', {
      kind: 'chatContext',
      query: 'cl',
      handle: 7,
      label: 'Perforce CL',
    })

    expect(harness.chatContext.resolveItemOrThrow).toHaveBeenCalledWith(7, 'cl', {
      sessionDir: '/workspace/demo/sub',
    })
    expect(result).toEqual({
      ok: true,
      value: {
        kind: 'chatContext',
        entry: {
          kind: 'chatContext',
          label: 'CL 1',
          uri: '',
          text: 'body',
          description: 'Pick a changelist',
        },
      },
    })
  })

  it('rejects resolve for unknown sessions and chatContext without a handle', async () => {
    const harness = makeHarness()
    harness.workspace.current = { folder: URI.file('/workspace/demo'), name: 'demo' }
    harness.add(makeSession('s1'))

    await expect(
      harness.service.resolvePromptRef('missing', { kind: 'commit', query: '' }),
    ).resolves.toMatchObject({ ok: false, code: 'session_not_found' })
    await expect(
      harness.service.resolvePromptRef('s1', { kind: 'chatContext', query: '' }),
    ).resolves.toMatchObject({ ok: false, code: 'bad_request' })
  })

  it('rebuilds a commit ref from the repo root above a narrowed session', async () => {
    const harness = makeHarness()
    harness.workspace.current = { folder: URI.file('/workspace/demo'), name: 'demo' }
    const first = makeSession('s1', { cwd: '/workspace/demo/sub' })
    harness.add(first)
    harness.scmSourceControls.set([promptRefSourceControl('/workspace/demo')], undefined)
    const hash = 'a'.repeat(40)

    await expect(
      harness.service.sendPrompt(
        's1',
        'see #a1b2c3d fix',
        [],
        [
          {
            kind: 'commit',
            label: 'a1b2c3d fix',
            uri: URI.file('/workspace/demo').toString(),
            commitHash: hash,
            text: 'fix',
            start: 4,
            end: 16,
          },
        ],
      ),
    ).resolves.toEqual({ ok: true, value: undefined })
    expect(callSpy(first.session, 'sendPrompt')).toHaveBeenCalledWith(
      'see #a1b2c3d fix',
      [
        expect.objectContaining({
          ref: expect.objectContaining({
            kind: 'commit',
            uri: URI.file('/workspace/demo').toString(),
            meta: { commitHash: hash, description: 'fix' },
          }),
        }),
      ],
      undefined,
      [],
      [],
    )
  })

  it('converts phone prompt refs into placed refs', async () => {
    const harness = makeHarness()
    harness.workspace.current = { folder: URI.file('/workspace/demo'), name: 'demo' }
    const first = makeSession('s1')
    harness.add(first)

    await expect(
      harness.service.sendPrompt(
        's1',
        'see @src/a.ts',
        [],
        [
          {
            kind: 'file',
            label: 'src/a.ts',
            uri: 'file:///workspace/demo/src/a.ts',
            start: 4,
            end: 13,
          },
        ],
      ),
    ).resolves.toEqual({ ok: true, value: undefined })
    expect(callSpy(first.session, 'sendPrompt')).toHaveBeenCalledWith(
      'see @src/a.ts',
      [
        expect.objectContaining({
          start: 4,
          end: 13,
          ref: expect.objectContaining({
            kind: 'file',
            label: 'src/a.ts',
            uri: 'file:///workspace/demo/src/a.ts',
          }),
        }),
      ],
      undefined,
      [],
      [],
    )
  })

  it('converts docs refs using the real docs roots', async () => {
    const harness = makeHarness()
    harness.workspace.current = { folder: URI.file('/workspace/demo'), name: 'demo' }
    const first = makeSession('s1')
    harness.add(first)
    const dirPath = '/docs/user/zh-CN'

    await expect(
      harness.service.sendPrompt(
        's1',
        '#Editor User Guide',
        [],
        [
          {
            kind: 'docs',
            label: 'Editor User Guide',
            uri: URI.file(dirPath).toString(),
            dirPath,
            start: 0,
            end: 18,
          },
        ],
      ),
    ).resolves.toEqual({ ok: true, value: undefined })
    expect(harness.docs.getDocsRoot).toHaveBeenCalledWith('user')
    expect(callSpy(first.session, 'sendPrompt')).toHaveBeenCalledWith(
      '#Editor User Guide',
      [
        expect.objectContaining({
          ref: expect.objectContaining({
            kind: 'docs',
            meta: expect.objectContaining({ dirPath }),
          }),
        }),
      ],
      undefined,
      [],
      [],
    )
  })

  it('rejects forged refs without dispatching the prompt', async () => {
    const harness = makeHarness()
    harness.workspace.current = { folder: URI.file('/workspace/demo'), name: 'demo' }
    const first = makeSession('s1')
    harness.add(first)

    await expect(
      harness.service.sendPrompt(
        's1',
        'see @src/a.ts',
        [],
        [
          {
            kind: 'file',
            label: 'src/a.ts',
            uri: 'file:///other/src/a.ts',
            start: 4,
            end: 13,
          },
        ],
      ),
    ).resolves.toMatchObject({ ok: false, code: 'bad_request' })
    expect(callSpy(first.session, 'sendPrompt')).not.toHaveBeenCalled()
  })

  it('keeps attachments and refs in one prompt', async () => {
    const harness = makeHarness()
    harness.workspace.current = { folder: URI.file('/workspace/demo'), name: 'demo' }
    const first = makeSession('s1')
    harness.add(first)

    await expect(
      harness.service.sendPrompt(
        's1',
        '@src/a.ts',
        [
          {
            kind: 'image',
            id: 'a1',
            name: 'shot.png',
            mimeType: 'image/png',
            byteSize: 3,
            dataBase64: 'AAA=',
          },
        ],
        [
          {
            kind: 'file',
            label: 'src/a.ts',
            uri: 'file:///workspace/demo/src/a.ts',
            start: 0,
            end: 9,
          },
        ],
      ),
    ).resolves.toEqual({ ok: true, value: undefined })
    expect(callSpy(first.session, 'sendPrompt')).toHaveBeenCalledWith(
      '@src/a.ts',
      [expect.objectContaining({ start: 0, end: 9 })],
      undefined,
      [expect.objectContaining({ id: 'a1' })],
      [],
    )
  })

  it('rejects unknown sessions, read-only sessions and unknown ids', async () => {
    const harness = makeHarness()
    const readOnly = makeSession('ro', { readOnly: true })
    harness.add(readOnly)

    await expect(harness.service.sendPrompt('missing', 'x')).resolves.toMatchObject({
      ok: false,
      code: 'session_not_found',
    })
    await expect(harness.service.sendPrompt('ro', 'x')).resolves.toMatchObject({
      ok: false,
      code: 'session_read_only',
    })
    await expect(harness.service.resolvePermission('ro', 'r1', 'allow')).resolves.toMatchObject({
      ok: false,
      code: 'session_read_only',
    })
    await expect(harness.service.renameSession('missing', 'x')).resolves.toMatchObject({
      ok: false,
      code: 'session_not_found',
    })
  })

  it('settles a permission once with the mobile source and rejects stale or unknown options', async () => {
    const harness = makeHarness()
    const first = makeSession('s1')
    harness.add(first)
    const pending = makePermission('req-1', [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'allow-always', name: 'Always', kind: 'allow_always' },
    ])
    first.pendingPermission.set(pending, undefined)

    await expect(
      harness.service.resolvePermission('s1', 'stale', 'allow-once'),
    ).resolves.toMatchObject({
      ok: false,
      code: 'stale_request',
    })
    await expect(
      harness.service.resolvePermission('s1', 'req-1', 'missing'),
    ).resolves.toMatchObject({
      ok: false,
      code: 'bad_request',
    })
    expect(pending.resolveWithSource).not.toHaveBeenCalled()

    await expect(
      harness.service.resolvePermission('s1', 'req-1', 'allow-once', 'looks good'),
    ).resolves.toEqual({ ok: true, value: undefined })
    expect(pending.resolveWithSource).toHaveBeenCalledWith('allow-once', 'mobile', 'looks good')
  })

  it('allows durable grants and bypass values from the phone', async () => {
    const harness = makeHarness()
    const first = makeSession('s1')
    harness.add(first)
    const pending = makePermission('req-1', [
      { optionId: 'allow-always', name: 'Always', kind: 'allow_always' },
    ])
    first.pendingPermission.set(pending, undefined)
    first.configOptions.set(
      [
        {
          id: 'approval',
          name: 'Approval',
          type: 'select',
          currentValue: 'ask',
          options: [
            { value: 'ask', name: 'Ask' },
            { value: 'bypassPermissions', name: 'Bypass' },
          ],
        },
      ] as unknown as SessionConfigOption[],
      undefined,
    )

    await expect(harness.service.resolvePermission('s1', 'req-1', 'allow-always')).resolves.toEqual(
      { ok: true, value: undefined },
    )
    expect(pending.resolveWithSource).toHaveBeenCalledWith('allow-always', 'mobile', undefined)

    await expect(
      harness.service.setConfigOption('s1', 'approval', 'bypassPermissions'),
    ).resolves.toEqual({ ok: true, value: undefined })
    expect(callSpy(first.session, 'setConfigOption')).toHaveBeenCalledWith(
      'approval',
      'bypassPermissions',
    )
  })

  it('cancels a permission with the mobile source and rejects stale requests', async () => {
    const harness = makeHarness()
    const first = makeSession('s1')
    harness.add(first)
    const pending = makePermission('req-1', [{ optionId: 'allow-once', name: 'Allow' }])
    first.pendingPermission.set(pending, undefined)

    await expect(harness.service.cancelPermission('s1', 'other')).resolves.toMatchObject({
      ok: false,
      code: 'stale_request',
    })
    await expect(harness.service.cancelPermission('s1', 'req-1')).resolves.toEqual({
      ok: true,
      value: undefined,
    })
    expect(pending.cancelWithSource).toHaveBeenCalledWith('mobile', 'cancelled')
  })

  it('resolves an elicitation with the mobile source and rejects stale requests', async () => {
    const harness = makeHarness()
    const first = makeSession('s1')
    harness.add(first)
    const pending = makeElicitation('e1')
    first.pendingElicitation.set(pending, undefined)

    await expect(
      harness.service.resolveElicitation('s1', 'stale', 'decline'),
    ).resolves.toMatchObject({
      ok: false,
      code: 'stale_request',
    })
    await expect(
      harness.service.resolveElicitation('s1', 'e1', 'accept', { name: 'Ada' }),
    ).resolves.toEqual({ ok: true, value: undefined })
    expect(pending.resolveWithSource).toHaveBeenCalledWith(
      { action: 'accept', content: { name: 'Ada' } },
      'mobile',
    )
    await expect(harness.service.resolveElicitation('s1', 'nope', 'cancel')).resolves.toMatchObject(
      {
        ok: false,
        code: 'stale_request',
      },
    )
  })

  it('routes bypass values and rejects unknown config ids/values', async () => {
    const harness = makeHarness()
    const first = makeSession('s1')
    harness.add(first)
    first.configOptions.set(
      [
        {
          id: 'approval',
          name: 'Approval',
          type: 'select',
          currentValue: 'ask',
          options: [
            { value: 'ask', name: 'Ask' },
            { value: 'bypassPermissions', name: 'Bypass' },
          ],
        },
        { id: 'fast', name: 'Fast', type: 'boolean', currentValue: false },
      ] as unknown as SessionConfigOption[],
      undefined,
    )

    await expect(
      harness.service.setConfigOption('s1', 'approval', 'bypassPermissions'),
    ).resolves.toEqual({ ok: true, value: undefined })
    expect(callSpy(first.session, 'setConfigOption')).toHaveBeenCalledWith(
      'approval',
      'bypassPermissions',
    )
    await expect(
      harness.service.setConfigOption('s1', 'approval', 'missing'),
    ).resolves.toMatchObject({
      ok: false,
      code: 'bad_request',
    })
    await expect(harness.service.setConfigOption('s1', 'missing', 'ask')).resolves.toMatchObject({
      ok: false,
      code: 'bad_request',
    })
    await expect(harness.service.setConfigOption('s1', 'fast', 'true')).resolves.toMatchObject({
      ok: false,
      code: 'bad_request',
    })
    expect(callSpy(first.session, 'setConfigOption')).toHaveBeenCalledTimes(1)
  })

  it('forwards auto-resolve pause and resume, rejecting stale countdowns', async () => {
    const harness = makeHarness()
    const first = makeSession('s1')
    harness.add(first)
    const pause = vi.fn()
    const resume = vi.fn()
    const pending = makePermission('req-1', [{ optionId: 'execute', name: 'Execute' }], {
      autoResolve: {
        optionId: 'execute',
        delayMs: 3000,
        state: observableValue('test.auto', {
          paused: false,
          remainingMs: 3000,
          cancelled: false,
        }),
        pause,
        resume,
        cancel: vi.fn(),
      },
    })
    first.pendingPermission.set(pending, undefined)

    await expect(harness.service.pauseAutoResolve('s1', 'stale')).resolves.toMatchObject({
      ok: false,
      code: 'stale_request',
    })
    await expect(harness.service.pauseAutoResolve('s1', 'req-1')).resolves.toEqual({
      ok: true,
      value: undefined,
    })
    await expect(harness.service.resumeAutoResolve('s1', 'req-1')).resolves.toEqual({
      ok: true,
      value: undefined,
    })
    expect(pause).toHaveBeenCalled()
    expect(resume).toHaveBeenCalled()
  })

  it('creates a session for a known agent and forwards the initial prompt', async () => {
    const harness = makeHarness()
    const created = makeSession('new-1', { durableId: 'd-new' })
    harness.created.mockReturnValue(created.session)

    await expect(
      harness.service.newSession('fake', { folder: 'file:///workspace/demo' }, 'start here'),
    ).resolves.toEqual({ ok: true, value: { localId: 'new-1', durableId: 'd-new' } })
    expect(harness.sessionService.createSession).toHaveBeenCalledWith('fake', {
      cwd: '/workspace/demo',
    })
    expect(callSpy(created.session, 'sendPrompt')).toHaveBeenCalledWith('start here')

    await expect(
      harness.service.newSession('unknown', { folder: 'file:///workspace/demo' }, null),
    ).resolves.toMatchObject({ ok: false, code: 'bad_request' })
    await expect(
      harness.service.newSession('fake', { folder: 'not a uri' }, null),
    ).resolves.toMatchObject({
      ok: false,
      code: 'bad_request',
    })
  })

  it('creates a session in the workspace root without touching the file system', async () => {
    const harness = makeHarness()
    harness.created.mockReturnValue(makeSession('root-1').session)

    await expect(
      harness.service.newSession('fake', { folder: 'file:///workspace/demo' }, null),
    ).resolves.toEqual({ ok: true, value: { localId: 'root-1' } })
    expect(harness.files.stat).not.toHaveBeenCalled()
    expect(harness.sessionService.createSession).toHaveBeenCalledWith('fake', {
      cwd: '/workspace/demo',
    })
  })

  it('validates a workspace subdirectory and uses it as the session cwd', async () => {
    const stat = vi.fn(
      async (resource: URI): Promise<IFileStat> => ({
        resource,
        isFile: false,
        isDirectory: true,
        size: 0,
        mtime: 0,
      }),
    )
    const harness = makeHarness({ stat })
    harness.created.mockReturnValue(makeSession('sub-1').session)

    await expect(
      harness.service.newSession(
        'fake',
        { folder: 'file:///workspace/demo', relativePath: 'packages/ui' },
        null,
      ),
    ).resolves.toEqual({ ok: true, value: { localId: 'sub-1' } })
    expect(vi.mocked(stat).mock.calls[0]?.[0].toString()).toBe('file:///workspace/demo/packages/ui')
    expect(harness.sessionService.createSession).toHaveBeenCalledWith('fake', {
      cwd: '/workspace/demo/packages/ui',
    })
  })

  it('rejects a missing or non-directory session directory without creating a session', async () => {
    const missing = makeHarness({
      stat: vi.fn(async () => {
        throw Object.assign(new Error('ENOENT: /workspace/demo/gone'), { code: 'ENOENT' })
      }),
    })
    await expect(
      missing.service.newSession(
        'fake',
        { folder: 'file:///workspace/demo', relativePath: 'gone' },
        null,
      ),
    ).resolves.toMatchObject({ ok: false, code: 'bad_request' })
    expect(missing.sessionService.createSession).not.toHaveBeenCalled()

    const file = makeHarness({
      stat: vi.fn(
        async (resource: URI): Promise<IFileStat> => ({
          resource,
          isFile: true,
          isDirectory: false,
          size: 1,
          mtime: 0,
        }),
      ),
    })
    await expect(
      file.service.newSession(
        'fake',
        { folder: 'file:///workspace/demo', relativePath: 'notes.txt' },
        null,
      ),
    ).resolves.toMatchObject({ ok: false, code: 'bad_request' })
    expect(file.sessionService.createSession).not.toHaveBeenCalled()
  })

  it('maps a transport failure while inspecting the directory to internal', async () => {
    const statFailure = makeHarness({
      stat: vi.fn(async () => {
        throw new Error('remote connection closed')
      }),
    })
    await expect(
      statFailure.service.newSession(
        'fake',
        { folder: 'file:///workspace/demo', relativePath: 'packages' },
        null,
      ),
    ).resolves.toMatchObject({ ok: false, code: 'internal' })
    expect(statFailure.sessionService.createSession).not.toHaveBeenCalled()

    const directoryStat = vi.fn(
      async (resource: URI): Promise<IFileStat> => ({
        resource,
        isFile: false,
        isDirectory: true,
        size: 0,
        mtime: 0,
      }),
    )
    const realpathFailure = makeHarness({
      stat: directoryStat,
      realpath: vi.fn(async () => {
        throw new Error('remote connection closed')
      }),
    })
    await expect(
      realpathFailure.service.newSession(
        'fake',
        { folder: 'file:///workspace/demo', relativePath: 'packages' },
        null,
      ),
    ).resolves.toMatchObject({ ok: false, code: 'internal' })
    expect(realpathFailure.sessionService.createSession).not.toHaveBeenCalled()
  })

  it('keeps a revived EACCES from realpath a bad_request', async () => {
    const harness = makeHarness({
      stat: vi.fn(
        async (resource: URI): Promise<IFileStat> => ({
          resource,
          isFile: false,
          isDirectory: true,
          size: 0,
          mtime: 0,
        }),
      ),
      realpath: vi.fn(async () => {
        throw Object.assign(new Error('EACCES: /workspace/demo/packages'), { code: 'EACCES' })
      }),
    })
    await expect(
      harness.service.newSession(
        'fake',
        { folder: 'file:///workspace/demo', relativePath: 'packages' },
        null,
      ),
    ).resolves.toMatchObject({ ok: false, code: 'bad_request' })
    expect(harness.sessionService.createSession).not.toHaveBeenCalled()
  })

  it('rejects a subdirectory whose real path escapes the workspace', async () => {
    const harness = makeHarness({
      stat: vi.fn(
        async (resource: URI): Promise<IFileStat> => ({
          resource,
          isFile: false,
          isDirectory: true,
          size: 0,
          mtime: 0,
        }),
      ),
      realpath: vi.fn(async (uri: URI) =>
        uri.fsPath === '/workspace/demo/link' ? URI.file('/elsewhere/link') : uri,
      ),
    })

    await expect(
      harness.service.newSession(
        'fake',
        { folder: 'file:///workspace/demo', relativePath: 'link' },
        null,
      ),
    ).resolves.toMatchObject({ ok: false, code: 'bad_request' })
    expect(harness.sessionService.createSession).not.toHaveBeenCalled()
  })

  it('allows a symlinked workspace when the real paths still nest', async () => {
    const harness = makeHarness({
      stat: vi.fn(
        async (resource: URI): Promise<IFileStat> => ({
          resource,
          isFile: false,
          isDirectory: true,
          size: 0,
          mtime: 0,
        }),
      ),
      realpath: vi.fn(async (uri: URI) => {
        if (uri.fsPath === '/workspace/demo') return URI.file('/mnt/real')
        if (uri.fsPath === '/workspace/demo/packages/ui') return URI.file('/mnt/real/packages/ui')
        return uri
      }),
    })
    harness.created.mockReturnValue(makeSession('sub-2').session)

    await expect(
      harness.service.newSession(
        'fake',
        { folder: 'file:///workspace/demo', relativePath: 'packages/ui' },
        null,
      ),
    ).resolves.toEqual({ ok: true, value: { localId: 'sub-2' } })
    expect(harness.sessionService.createSession).toHaveBeenCalledWith('fake', {
      cwd: '/workspace/demo/packages/ui',
    })
  })

  it('rejects invalid workspace-relative paths before touching the file system', async () => {
    const harness = makeHarness()

    for (const relativePath of ['../outside', '/abs', 'a\\b', 'a//b', 'a/./b']) {
      await expect(
        harness.service.newSession(
          'fake',
          { folder: 'file:///workspace/demo', relativePath },
          null,
        ),
      ).resolves.toMatchObject({ ok: false, code: 'bad_request' })
    }
    expect(harness.files.stat).not.toHaveBeenCalled()
    expect(harness.sessionService.createSession).not.toHaveBeenCalled()
  })

  it('keeps the remote authority when creating a session in a remote subdirectory', async () => {
    const stat = vi.fn(
      async (resource: URI): Promise<IFileStat> => ({
        resource,
        isFile: false,
        isDirectory: true,
        size: 0,
        mtime: 0,
      }),
    )
    const harness = makeHarness({ stat })
    harness.created.mockReturnValue(makeSession('remote-1').session)

    await expect(
      harness.service.newSession(
        'fake',
        { folder: 'remote-ssh://ssh-remote+host/home/dev/proj', relativePath: 'packages/ui' },
        null,
      ),
    ).resolves.toEqual({ ok: true, value: { localId: 'remote-1' } })
    expect(vi.mocked(stat).mock.calls[0]?.[0].toString()).toBe(
      'remote-ssh://ssh-remote+host/home/dev/proj/packages/ui',
    )
    expect(harness.sessionService.createSession).toHaveBeenCalledWith('fake', {
      cwd: '/home/dev/proj/packages/ui',
      authority: 'ssh-remote+host',
    })
  })

  it('does not create a session when the gateway already cancelled the request', async () => {
    const harness = makeHarness()
    const cts = new CancellationTokenSource()
    cts.cancel()

    await expect(
      harness.service.newSession('fake', { folder: 'file:///workspace/demo' }, null, cts.token),
    ).resolves.toMatchObject({ ok: false, code: 'internal' })
    expect(harness.sessionService.createSession).not.toHaveBeenCalled()
  })

  it('waits for user settings hydration before creating a session', async () => {
    const harness = makeHarness()
    const gate = new DeferredPromise<void>()
    harness.userSettings.whenInitialized = gate.p
    harness.created.mockReturnValue(makeSession('new-2').session)

    const pending = harness.service.newSession('fake', { folder: 'file:///workspace/demo' }, null)
    await Promise.resolve()
    expect(harness.sessionService.createSession).not.toHaveBeenCalled()

    gate.complete()
    await expect(pending).resolves.toEqual({ ok: true, value: { localId: 'new-2' } })
    expect(harness.sessionService.createSession).toHaveBeenCalledTimes(1)
  })

  it('waits for user settings hydration before listing agents', async () => {
    const harness = makeHarness()
    const gate = new DeferredPromise<void>()
    harness.userSettings.whenInitialized = gate.p

    const pending = harness.service.listAgents()
    let settled = false
    void pending.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    gate.complete()
    await expect(pending).resolves.toEqual([
      { id: 'fake', name: 'Fake Agent', isDefault: true },
      { id: 'other', name: 'Other Agent', isDefault: false },
    ])
  })

  it('closes a live session through the shared close path without deleting history', async () => {
    const harness = makeHarness()
    const first = makeSession('s1')
    harness.add(first)

    await expect(harness.service.closeSession('s1')).resolves.toEqual({
      ok: true,
      value: undefined,
    })
    expect(harness.sessionService.closeSession).toHaveBeenCalledWith('s1')
    expect(harness.sessionService.deleteOnAgent).not.toHaveBeenCalled()
  })

  it('rejects closing a read-only session', async () => {
    const harness = makeHarness()
    const first = makeSession('s1', { readOnly: true })
    harness.add(first)

    await expect(harness.service.closeSession('s1')).resolves.toMatchObject({
      ok: false,
      code: 'session_read_only',
    })
    expect(harness.sessionService.closeSession).not.toHaveBeenCalled()
  })

  it('deletes a session through the shared removal pipeline', async () => {
    const harness = makeHarness()
    const first = makeSession('s1')
    harness.add(first)

    await expect(harness.service.deleteSession('s1')).resolves.toEqual({
      ok: true,
      value: undefined,
    })
    expect(harness.sessionService.closeSession).toHaveBeenCalledWith('s1')
  })

  it('deletes a history-only row through the shared removal pipeline', async () => {
    const harness = makeHarness()
    harness.workspace.current = {
      folder: URI.parse('file:///workspace/demo'),
      name: 'demo',
    }
    harness.history.set([makeHistoryEntry('d1', { cwd: '/workspace/demo' })], undefined)

    await expect(harness.service.deleteHistorySession('d1')).resolves.toEqual({
      ok: true,
      value: undefined,
    })
    expect(harness.sessionService.closeSession).not.toHaveBeenCalled()
    expect(harness.sessionService.deleteOnAgent).toHaveBeenCalledWith('d1')
    expect(harness.historyService.removeDeleted).toHaveBeenCalledWith('d1')
  })

  it('closes the live instance when the PC resumed a history row first', async () => {
    const harness = makeHarness()
    harness.workspace.current = {
      folder: URI.parse('file:///workspace/demo'),
      name: 'demo',
    }
    harness.add(makeSession('s1', { durableId: 'd1' }))
    harness.history.set([makeHistoryEntry('d1', { cwd: '/workspace/demo' })], undefined)

    await expect(harness.service.deleteHistorySession('d1')).resolves.toEqual({
      ok: true,
      value: undefined,
    })
    expect(harness.sessionService.closeSession).toHaveBeenCalledWith('s1')
    expect(harness.sessionService.deleteOnAgent).toHaveBeenCalledWith('d1')
    expect(harness.historyService.removeDeleted).toHaveBeenCalledWith('d1')
  })

  it('rejects deleting a history row this window does not own', async () => {
    const harness = makeHarness()
    harness.workspace.current = {
      folder: URI.parse('file:///workspace/demo'),
      name: 'demo',
    }
    harness.history.set([makeHistoryEntry('d1', { cwd: '/other/project' })], undefined)

    await expect(harness.service.deleteHistorySession('d1')).resolves.toMatchObject({
      ok: false,
      code: 'forbidden_operation',
    })
    expect(harness.sessionService.deleteOnAgent).not.toHaveBeenCalled()
    expect(harness.historyService.removeDeleted).not.toHaveBeenCalled()
  })

  it('reports session_not_found for an unknown history row', async () => {
    const harness = makeHarness()

    await expect(harness.service.deleteHistorySession('missing')).resolves.toMatchObject({
      ok: false,
      code: 'session_not_found',
    })
    expect(harness.sessionService.deleteOnAgent).not.toHaveBeenCalled()
  })

  it('keeps the live guards when deleting a history row that became live', async () => {
    const readOnly = makeHarness()
    readOnly.workspace.current = {
      folder: URI.parse('file:///workspace/demo'),
      name: 'demo',
    }
    readOnly.add(makeSession('s1', { durableId: 'd1', readOnly: true }))
    readOnly.history.set([makeHistoryEntry('d1', { cwd: '/workspace/demo' })], undefined)

    await expect(readOnly.service.deleteHistorySession('d1')).resolves.toMatchObject({
      ok: false,
      code: 'session_read_only',
    })
    expect(readOnly.sessionService.deleteOnAgent).not.toHaveBeenCalled()

    const busy = makeHarness()
    busy.workspace.current = {
      folder: URI.parse('file:///workspace/demo'),
      name: 'demo',
    }
    busy.add(makeSession('s1', { durableId: 'd1' }))
    busy.history.set([makeHistoryEntry('d1', { cwd: '/workspace/demo' })], undefined)
    vi.mocked(busy.delivery.isDeliveryBusyForSession).mockReturnValue(true)

    await expect(busy.service.deleteHistorySession('d1')).resolves.toMatchObject({
      ok: false,
      code: 'delivery_busy',
    })
    expect(busy.sessionService.deleteOnAgent).not.toHaveBeenCalled()
  })

  it('lists this window workspace and the visible agents', async () => {
    const harness = makeHarness()
    harness.workspace.current = {
      folder: URI.parse('file:///workspace/demo'),
      name: 'demo',
    }

    await expect(harness.service.listWorkspaces()).resolves.toStrictEqual([
      { folder: 'file:///workspace/demo', name: 'demo', isOpen: true },
    ])
    await expect(harness.service.listAgents()).resolves.toStrictEqual([
      { id: 'fake', name: 'Fake Agent', isDefault: true },
      { id: 'other', name: 'Other Agent', isDefault: false },
    ])
  })
})

describe('MobileBridgeService session settings', () => {
  function modelOption(...values: string[]): SessionConfigOption {
    return {
      id: 'model',
      category: 'model',
      type: 'select',
      name: 'Model',
      currentValue: values[0] ?? 'sonnet',
      options: values.map((value) => ({ value, name: value })),
    } as unknown as SessionConfigOption
  }

  function mcpDef(
    name: string,
    options: {
      disabled?: boolean
      agentAffinity?: 'claude-code' | 'codex'
      sharedWith?: readonly ('claude-code' | 'codex')[]
    } = {},
  ): McpServerDefinition {
    return {
      name,
      transport: 'stdio',
      disabled: options.disabled ?? false,
      source: options.agentAffinity === undefined ? 'global' : 'agent-user',
      ...(options.agentAffinity !== undefined ? { agentAffinity: options.agentAffinity } : {}),
      ...(options.sharedWith !== undefined ? { sharedWith: options.sharedWith } : {}),
    } as McpServerDefinition
  }

  it('projects claude subagent settings and the filtered MCP pool', async () => {
    const harness = makeHarness()
    harness.claudeSettings.env = { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' }
    harness.mcpServerDefinitions.set(
      [
        mcpDef('shared'),
        mcpDef('claude-only', { agentAffinity: 'claude-code' }),
        mcpDef('codex-only', { agentAffinity: 'codex' }),
        mcpDef('off-by-default', { disabled: true }),
      ],
      undefined,
    )
    const first = makeSession('s1', {
      agentId: 'claude-code',
      authority: 'ssh-remote+host-a',
      mcpStatuses: [
        { name: 'shared', status: 'connected', transport: 'stdio' },
        { name: 'claude-only', status: 'failed' },
      ],
    })
    first.configOptions.set([modelOption('sonnet', 'opus')], undefined)
    harness.add(first)

    await expect(harness.service.getSessionSettings('s1')).resolves.toStrictEqual({
      ok: true,
      value: {
        canEdit: true,
        subagentModel: {
          supported: true,
          current: 'haiku',
          candidates: ['sonnet', 'opus', 'haiku'],
        },
        mcp: {
          pool: [
            { name: 'shared', transport: 'stdio', defaultDisabled: false },
            { name: 'claude-only', transport: 'stdio', defaultDisabled: false },
            { name: 'off-by-default', transport: 'stdio', defaultDisabled: true },
          ],
          selection: null,
          enabled: ['shared', 'claude-only'],
          live: [
            { name: 'shared', status: 'connected', transport: 'stdio' },
            { name: 'claude-only', status: 'failed' },
          ],
        },
      },
    })
    expect(harness.claudeRead).toHaveBeenCalledWith('ssh-remote+host-a')
    expect(harness.sessionService.refreshMcpServerDefinitions).toHaveBeenCalled()
  })

  it('reports an explicit MCP selection and read-only sessions', async () => {
    const harness = makeHarness()
    harness.mcpServerDefinitions.set(
      [mcpDef('a'), mcpDef('b', { disabled: true }), mcpDef('c')],
      undefined,
    )
    harness.add(
      makeSession('s1', {
        agentId: 'claude-code',
        readOnly: true,
        mcpSelection: ['b'],
      }),
    )

    const result = await harness.service.getSessionSettings('s1')
    expect(result).toMatchObject({
      ok: true,
      value: {
        canEdit: false,
        mcp: { selection: ['b'], enabled: ['b'] },
      },
    })
  })

  it('skips the claude settings read for non-claude agents', async () => {
    const harness = makeHarness()
    harness.add(makeSession('s1', { agentId: 'fake' }))

    const result = await harness.service.getSessionSettings('s1')
    expect(result).toMatchObject({
      ok: true,
      value: {
        subagentModel: { supported: false, current: null, candidates: [] },
      },
    })
    expect(harness.claudeRead).not.toHaveBeenCalled()
  })

  it('returns internal when the claude settings read fails', async () => {
    const harness = makeHarness()
    harness.claudeRead.mockRejectedValueOnce(new Error('disk on fire'))
    harness.add(makeSession('s1', { agentId: 'claude-code' }))

    await expect(harness.service.getSessionSettings('s1')).resolves.toMatchObject({
      ok: false,
      code: 'internal',
    })
  })

  it('writes the subagent model with the force flag on the session authority', async () => {
    const harness = makeHarness()
    harness.claudeSettings.env = { CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet' }
    const first = makeSession('s1', { agentId: 'claude-code', authority: 'host-a' })
    first.configOptions.set([modelOption('sonnet', 'opus')], undefined)
    harness.add(first)

    await expect(harness.service.setSubagentModel('s1', ' opus ')).resolves.toEqual({
      ok: true,
      value: undefined,
    })
    expect(harness.claudePatch).toHaveBeenCalledWith(
      {
        env: {
          CLAUDE_CODE_SUBAGENT_MODEL: 'opus',
          CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1',
        },
      },
      'host-a',
    )
  })

  it('clears both subagent env keys when following the main model', async () => {
    const harness = makeHarness()
    harness.claudeSettings.env = {
      CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet',
      CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1',
    }
    harness.add(makeSession('s1', { agentId: 'claude-code', authority: 'host-a' }))

    await expect(harness.service.setSubagentModel('s1', null)).resolves.toEqual({
      ok: true,
      value: undefined,
    })
    expect(harness.claudePatch).toHaveBeenCalledWith(
      {
        env: {
          CLAUDE_CODE_SUBAGENT_MODEL: null,
          CLAUDE_CODE_SUBAGENT_MODEL_FORCE: null,
        },
      },
      'host-a',
    )
    expect(harness.claudeRead).not.toHaveBeenCalled()
  })

  it('accepts a model already on disk even when it is no longer offered', async () => {
    const harness = makeHarness()
    harness.claudeSettings.env = { CLAUDE_CODE_SUBAGENT_MODEL: 'legacy-model' }
    harness.add(makeSession('s1', { agentId: 'claude-code' }))

    await expect(harness.service.setSubagentModel('s1', 'legacy-model')).resolves.toEqual({
      ok: true,
      value: undefined,
    })
    expect(harness.claudePatch).toHaveBeenCalled()
  })

  it('rejects unknown models without touching the settings', async () => {
    const harness = makeHarness()
    const first = makeSession('s1', { agentId: 'claude-code' })
    first.configOptions.set([modelOption('sonnet')], undefined)
    harness.add(first)

    await expect(harness.service.setSubagentModel('s1', 'gpt-5')).resolves.toMatchObject({
      ok: false,
      code: 'bad_request',
    })
    expect(harness.claudePatch).not.toHaveBeenCalled()
  })

  it('guards subagent writes by agent and read-only state', async () => {
    const harness = makeHarness()
    harness.add(makeSession('s1', { agentId: 'fake' }))
    harness.add(makeSession('s2', { agentId: 'claude-code', readOnly: true }))

    await expect(harness.service.setSubagentModel('s1', 'opus')).resolves.toMatchObject({
      ok: false,
      code: 'unsupported_by_agent',
    })
    await expect(harness.service.setSubagentModel('s2', 'opus')).resolves.toMatchObject({
      ok: false,
      code: 'session_read_only',
    })
    expect(harness.claudePatch).not.toHaveBeenCalled()
  })

  it('returns internal when the claude settings write fails', async () => {
    const harness = makeHarness()
    harness.claudePatch.mockRejectedValueOnce(new Error('locked'))
    const first = makeSession('s1', { agentId: 'claude-code' })
    first.configOptions.set([modelOption('opus')], undefined)
    harness.add(first)

    await expect(harness.service.setSubagentModel('s1', 'opus')).resolves.toMatchObject({
      ok: false,
      code: 'internal',
    })
  })

  it('requests an agent process restart', async () => {
    const harness = makeHarness()
    const first = makeSession('s1', { agentId: 'claude-code', durableId: 'durable-1' })
    harness.add(first)

    await expect(harness.service.restartAgentProcess('s1')).resolves.toEqual({
      ok: true,
      value: undefined,
    })
    expect(first.requestProcessRestart).toHaveBeenCalledTimes(1)
  })

  it('refuses a restart without a durable id or while reconnecting', async () => {
    const harness = makeHarness()
    const noDurable = makeSession('s1', { agentId: 'claude-code' })
    const reconnecting = makeSession('s2', {
      agentId: 'claude-code',
      durableId: 'durable-2',
      isReconnecting: true,
    })
    harness.add(noDurable)
    harness.add(reconnecting)

    await expect(harness.service.restartAgentProcess('s1')).resolves.toMatchObject({
      ok: false,
      code: 'not_supported',
    })
    await expect(harness.service.restartAgentProcess('s2')).resolves.toMatchObject({
      ok: false,
      code: 'session_busy',
    })
    expect(noDurable.requestProcessRestart).not.toHaveBeenCalled()
    expect(reconnecting.requestProcessRestart).not.toHaveBeenCalled()
  })

  it('forwards a deduped MCP whitelist for the session agent', async () => {
    const harness = makeHarness()
    harness.mcpServerDefinitions.set(
      [
        mcpDef('shared'),
        mcpDef('claude-only', { agentAffinity: 'claude-code' }),
        mcpDef('codex-only', { agentAffinity: 'codex' }),
      ],
      undefined,
    )
    harness.add(makeSession('s1', { agentId: 'claude-code' }))

    await expect(
      harness.service.setSessionMcpServers('s1', ['shared', 'claude-only', 'shared', 'gone']),
    ).resolves.toEqual({ ok: true, value: undefined })
    expect(harness.setSessionMcpServers).toHaveBeenCalledWith('s1', [
      'shared',
      'claude-only',
      'gone',
    ])
  })

  it('forwards null to restore the default MCP selection', async () => {
    const harness = makeHarness()
    harness.add(makeSession('s1', { agentId: 'claude-code' }))

    await expect(harness.service.setSessionMcpServers('s1', null)).resolves.toEqual({
      ok: true,
      value: undefined,
    })
    expect(harness.setSessionMcpServers).toHaveBeenCalledWith('s1', null)
  })

  it('rejects MCP names owned by another agent', async () => {
    const harness = makeHarness()
    harness.mcpServerDefinitions.set(
      [mcpDef('shared'), mcpDef('codex-only', { agentAffinity: 'codex' })],
      undefined,
    )
    harness.add(makeSession('s1', { agentId: 'claude-code' }))

    await expect(harness.service.setSessionMcpServers('s1', ['codex-only'])).resolves.toMatchObject(
      { ok: false, code: 'bad_request' },
    )
    expect(harness.setSessionMcpServers).not.toHaveBeenCalled()
  })

  it('rejects an oversized MCP whitelist and read-only sessions', async () => {
    const harness = makeHarness()
    harness.add(makeSession('s1', { agentId: 'claude-code' }))
    harness.add(makeSession('s2', { agentId: 'claude-code', readOnly: true }))

    const tooMany = Array.from({ length: 101 }, (_, index) => `server-${index}`)
    await expect(harness.service.setSessionMcpServers('s1', tooMany)).resolves.toMatchObject({
      ok: false,
      code: 'bad_request',
    })
    await expect(harness.service.setSessionMcpServers('s2', ['shared'])).resolves.toMatchObject({
      ok: false,
      code: 'session_read_only',
    })
    expect(harness.setSessionMcpServers).not.toHaveBeenCalled()
  })
})

describe('MobileBridgeService fork / rewind / side tasks', () => {
  function fakeResultSession(id: string, durableId?: string): IAcpSession {
    return {
      id,
      sessionIdOnAgent: observableValue<string | undefined>('test.result', durableId),
    } as unknown as IAcpSession
  }

  function historyEntry(
    id: string,
    overrides: Partial<AcpSessionHistoryEntry> = {},
  ): AcpSessionHistoryEntry {
    return {
      id,
      agentId: 'fake',
      sessionIdOnAgent: id,
      title: `Session ${id}`,
      createdAt: 1,
      lastUsedAt: 1,
      ...overrides,
    } as unknown as AcpSessionHistoryEntry
  }

  it('projects resumable history rows, hiding archived, side-task and empty ones', async () => {
    const harness = makeHarness()
    harness.workspace.current = {
      folder: URI.parse('file:///workspace/demo'),
      name: 'demo',
    }
    harness.history.set(
      [
        historyEntry('d1', {
          title: 'Fix login',
          firstPrompt: '  fix the login flow  ',
          cwd: '/workspace/demo',
          createdAt: 10,
          lastUsedAt: 20,
        }),
        historyEntry('d2', {
          title: 'Pinned',
          cwd: '/workspace/demo/sub',
          pinned: true,
          lastUsedAt: 5,
        }),
        historyEntry('d3', { archived: true }),
        historyEntry('d4', { hasMessages: false }),
        historyEntry('d5', { sideTaskOf: 'd1' }),
        historyEntry('d6', { cwd: '/other/project' }),
        historyEntry('d7'),
      ],
      undefined,
    )

    const rows = await harness.service.listSessionHistory()

    expect(rows.map((row) => row.durableId)).toStrictEqual(['d2', 'd1', 'd7'])
    expect(rows[1]).toStrictEqual({
      durableId: 'd1',
      agentId: 'fake',
      agentName: 'Fake Agent',
      title: 'Fix login',
      firstPrompt: 'fix the login flow',
      cwd: '/workspace/demo',
      createdAt: 10,
      lastUsedAt: 20,
    })
    expect(rows[0]).toMatchObject({ pinned: true, cwd: '/workspace/demo/sub' })
  })

  it('answers history ownership and resumes without activating the PC window', async () => {
    const harness = makeHarness()
    harness.workspace.current = {
      folder: URI.parse('file:///workspace/demo'),
      name: 'demo',
    }
    harness.history.set(
      [
        historyEntry('d1', { cwd: '/workspace/demo' }),
        historyEntry('d2', { cwd: '/other/project' }),
        historyEntry('d3', { archived: true }),
        historyEntry('d4', { hasMessages: false }),
        historyEntry('d5', { sideTaskOf: 'd1' }),
      ],
      undefined,
    )
    expect(await harness.service.hasSessionHistory('d1')).toBe(true)
    expect(await harness.service.hasSessionHistory('missing')).toBe(false)
    expect(await harness.service.hasSessionHistory('d2')).toBe(false)
    expect(await harness.service.hasSessionHistory('d3')).toBe(false)
    expect(await harness.service.hasSessionHistory('d4')).toBe(false)
    expect(await harness.service.hasSessionHistory('d5')).toBe(false)

    harness.resumeSession.mockResolvedValueOnce(fakeResultSession('local-1', 'd1'))
    await expect(harness.service.openSession('d1')).resolves.toStrictEqual({
      ok: true,
      value: { localId: 'local-1', durableId: 'd1' },
    })
    expect(harness.resumeSession).toHaveBeenCalledWith('d1', { activate: false })

    await expect(harness.service.openSession('d2')).resolves.toMatchObject({
      ok: false,
      code: 'forbidden_operation',
    })
    await expect(harness.service.openSession('d3')).resolves.toMatchObject({
      ok: false,
      code: 'session_not_found',
    })
    await expect(harness.service.openSession('missing')).resolves.toMatchObject({
      ok: false,
      code: 'session_not_found',
    })
    expect(harness.resumeSession).toHaveBeenCalledTimes(1)
  })

  it('projects fork/rewind capabilities and side-task links onto summaries', async () => {
    const harness = makeHarness()
    const parent = makeSession('s1', {
      durableId: 'd1',
      forkSupported: true,
      rewindSupported: true,
    })
    harness.add(parent)
    harness.history.set(
      [
        historyEntry('d1', { title: 'Parent' }),
        historyEntry('side-1', { title: 'Side', sideTaskOf: 'd1', lastUsedAt: 5 }),
      ],
      undefined,
    )

    await expect(harness.service.getSnapshot('s1')).resolves.toMatchObject({
      summary: {
        localId: 's1',
        durableId: 'd1',
        forkSupported: true,
        rewindSupported: true,
        sideTaskChildCount: 1,
      },
    })
    const summaries = await harness.service.listSessions()
    expect(summaries[0]).not.toHaveProperty('sideTaskOf')

    const side = makeSession('side-1', { durableId: 'side-1' })
    harness.add(side)
    await expect(harness.service.getSnapshot('side-1')).resolves.toMatchObject({
      summary: { sideTaskOf: 'd1' },
    })
  })

  it('projects message anchors and first-turn fork eligibility', async () => {
    const harness = makeHarness()
    const first = makeSession('s1', { durableId: 'd1', forkSupported: true })
    harness.add(first)
    const firstTurn = userMessage('m1', 'msg-1', 'first')
    const secondTurn = userMessage('m2', 'msg-2', 'second')
    first.messages.set([firstTurn, secondTurn], undefined)
    first.timeline.set(
      [
        { kind: 'message', id: 'm1', message: firstTurn },
        { kind: 'message', id: 'm2', message: secondTurn },
      ],
      undefined,
    )

    const snapshot = await harness.service.getSnapshot('s1')
    expect(snapshot?.timeline[0]).toMatchObject({ messageId: 'msg-1', canFork: false })
    expect(snapshot?.timeline[1]).toMatchObject({ messageId: 'msg-2', canFork: true })
  })

  it('forks without activating and refuses invalid anchors or a busy session', async () => {
    const harness = makeHarness()
    const first = makeSession('s1', { durableId: 'd1', forkSupported: true })
    harness.add(first)
    const firstTurn = userMessage('m1', 'msg-1', 'first')
    const retryTurn = userMessage('m2', 'msg-2', 'continue', { autoRetry: true })
    first.messages.set([firstTurn, retryTurn], undefined)

    await expect(harness.service.forkSession('missing')).resolves.toMatchObject({
      ok: false,
      code: 'session_not_found',
    })
    await expect(harness.service.forkSession('s1', 'nope')).resolves.toMatchObject({
      ok: false,
      code: 'invalid_anchor',
    })
    await expect(harness.service.forkSession('s1', 'msg-1')).resolves.toMatchObject({
      ok: false,
      code: 'invalid_anchor',
    })
    await expect(harness.service.forkSession('s1', 'msg-2')).resolves.toMatchObject({
      ok: false,
      code: 'invalid_anchor',
    })

    first.status.set('running', undefined)
    await expect(harness.service.forkSession('s1')).resolves.toMatchObject({
      ok: false,
      code: 'session_busy',
    })
    first.status.set('idle', undefined)

    harness.forkSession.mockResolvedValueOnce(fakeResultSession('forked', 'fork-durable'))
    await expect(harness.service.forkSession('s1')).resolves.toEqual({
      ok: true,
      value: { localId: 'forked', durableId: 'fork-durable' },
    })
    expect(harness.forkSession).toHaveBeenCalledWith('s1', undefined, { activate: false })
  })

  it('rejects fork when the agent or session does not allow it', async () => {
    const harness = makeHarness()
    const readOnly = makeSession('ro', { readOnly: true, forkSupported: true })
    const unsupported = makeSession('plain')
    harness.add(readOnly)
    harness.add(unsupported)

    await expect(harness.service.forkSession('ro')).resolves.toMatchObject({
      ok: false,
      code: 'session_read_only',
    })
    await expect(harness.service.forkSession('plain')).resolves.toMatchObject({
      ok: false,
      code: 'unsupported_by_agent',
    })
    expect(harness.forkSession).not.toHaveBeenCalled()
  })

  it('previews a rewind without mutating and treats canRewind:false as a result', async () => {
    const harness = makeHarness()
    const first = makeSession('s1', { durableId: 'd1', rewindSupported: true })
    harness.add(first)
    first.messages.set([userMessage('m1', 'msg-1', 'first')], undefined)

    harness.rewindSession.mockResolvedValueOnce({
      canRewind: true,
      filesChanged: ['/workspace/a.ts', '/workspace/b.ts'],
      insertions: 2,
      deletions: 1,
    })
    await expect(harness.service.previewRewind('s1', 'msg-1')).resolves.toEqual({
      ok: true,
      value: { canRewind: true, filesChanged: 2, insertions: 2, deletions: 1 },
    })
    expect(harness.rewindSession).toHaveBeenCalledWith('s1', 'msg-1', { dryRun: true })

    harness.rewindSession.mockResolvedValueOnce({ canRewind: false, error: 'no checkpoint' })
    await expect(harness.service.previewRewind('s1', 'msg-1')).resolves.toEqual({
      ok: true,
      value: { canRewind: false, error: 'no checkpoint', filesChanged: 0 },
    })
  })

  it('validates rewind anchors and capability before delegating', async () => {
    const harness = makeHarness()
    const plain = makeSession('plain')
    const rewound = makeSession('s1', { durableId: 'd1', rewindSupported: true })
    harness.add(plain)
    harness.add(rewound)
    rewound.messages.set([userMessage('m1', 'msg-1', 'first')], undefined)

    await expect(harness.service.previewRewind('plain', 'msg-1')).resolves.toMatchObject({
      ok: false,
      code: 'unsupported_by_agent',
    })
    await expect(harness.service.previewRewind('s1', 'nope')).resolves.toMatchObject({
      ok: false,
      code: 'invalid_anchor',
    })
    await expect(harness.service.rewindSession('s1', 'nope')).resolves.toMatchObject({
      ok: false,
      code: 'invalid_anchor',
    })
    expect(harness.rewindSession).not.toHaveBeenCalled()
  })

  it('captures the anchor text before rewinding and maps the file option', async () => {
    const harness = makeHarness()
    const first = makeSession('s1', { durableId: 'd1', rewindSupported: true })
    harness.add(first)
    first.messages.set([userMessage('m1', 'msg-1', 'original prompt')], undefined)

    harness.rewindSession.mockImplementationOnce(async () => {
      first.messages.set([], undefined)
      return { canRewind: true }
    })
    await expect(harness.service.rewindSession('s1', 'msg-1', false)).resolves.toEqual({
      ok: true,
      value: { canRewind: true, text: 'original prompt' },
    })
    expect(harness.rewindSession).toHaveBeenCalledWith('s1', 'msg-1', { rewindFiles: false })

    harness.rewindSession.mockResolvedValueOnce({ canRewind: true })
    first.messages.set([userMessage('m1', 'msg-1', 'original prompt')], undefined)
    await harness.service.rewindSession('s1', 'msg-1')
    expect(harness.rewindSession).toHaveBeenLastCalledWith('s1', 'msg-1', {})

    harness.rewindSession.mockResolvedValueOnce({ canRewind: false, error: 'locked' })
    first.messages.set([userMessage('m1', 'msg-1', 'original prompt')], undefined)
    await expect(harness.service.rewindSession('s1', 'msg-1')).resolves.toEqual({
      ok: true,
      value: { canRewind: false, error: 'locked' },
    })
  })

  it('creates side tasks with a clipped quote and rejects unsupported agents', async () => {
    const harness = makeHarness()
    const parent = makeSession('s1', { durableId: 'd1', forkSupported: true })
    const plain = makeSession('plain')
    harness.add(parent)
    harness.add(plain)
    harness.forkSideTask.mockResolvedValue(fakeResultSession('side', 'side-durable'))

    await expect(harness.service.createSideTask('s1', '  hello   world  ')).resolves.toEqual({
      ok: true,
      value: { localId: 'side', durableId: 'side-durable' },
    })
    expect(harness.forkSideTask).toHaveBeenLastCalledWith('s1', {
      text: 'hello   world',
      label: 'hello world',
    })

    await harness.service.createSideTask('s1', '   ')
    expect(harness.forkSideTask).toHaveBeenLastCalledWith('s1', undefined)

    const long = 'x'.repeat(8001)
    await harness.service.createSideTask('s1', long)
    const [parentId, quote] = harness.forkSideTask.mock.calls.at(-1) as [
      string,
      { text: string; label: string },
    ]
    expect(parentId).toBe('s1')
    expect(quote.text).toHaveLength(8001)
    expect(quote.text.endsWith('…')).toBe(true)
    expect(quote.label).toHaveLength(60)

    await expect(harness.service.createSideTask('plain', 'why?')).resolves.toMatchObject({
      ok: false,
      code: 'unsupported_by_agent',
    })
  })

  it('lists direct side tasks, most recently used first, with live flags', async () => {
    const harness = makeHarness()
    const parent = makeSession('s1', { durableId: 'd1' })
    harness.add(parent)
    const liveChild = makeSession('side-1', { durableId: 'side-1' })
    harness.add(liveChild)
    harness.history.set(
      [
        historyEntry('side-1', { sideTaskOf: 'd1', lastUsedAt: 10 }),
        historyEntry('side-2', { sideTaskOf: 'd1', lastUsedAt: 20 }),
        historyEntry('side-1a', { sideTaskOf: 'side-1', lastUsedAt: 30 }),
        historyEntry('other', { sideTaskOf: 'd9', lastUsedAt: 40 }),
      ],
      undefined,
    )

    await expect(harness.service.listSideTasks('s1')).resolves.toEqual({
      ok: true,
      value: [
        { id: 'side-2', title: 'Session side-2', lastUsedAt: 20, live: false },
        { id: 'side-1', title: 'Session side-1', lastUsedAt: 10, live: true },
      ],
    })
  })

  it('opens a side task without activating it and rejects foreign rows', async () => {
    const harness = makeHarness()
    const parent = makeSession('s1', { durableId: 'd1' })
    harness.add(parent)
    harness.history.set(
      [historyEntry('side-1', { sideTaskOf: 'd1' }), historyEntry('other', { sideTaskOf: 'd9' })],
      undefined,
    )
    harness.resumeSession.mockResolvedValueOnce(fakeResultSession('side-1', 'side-1'))

    await expect(harness.service.openSideTask('s1', 'side-1')).resolves.toEqual({
      ok: true,
      value: { localId: 'side-1', durableId: 'side-1' },
    })
    expect(harness.resumeSession).toHaveBeenCalledWith('side-1', { activate: false })

    await expect(harness.service.openSideTask('s1', 'other')).resolves.toMatchObject({
      ok: false,
      code: 'invalid_anchor',
    })
    await expect(harness.service.openSideTask('s1', 'missing')).resolves.toMatchObject({
      ok: false,
      code: 'invalid_anchor',
    })
  })

  it('deletes a side task with its whole subtree and rejects foreign rows', async () => {
    const harness = makeHarness()
    const parent = makeSession('s1', { durableId: 'd1' })
    harness.add(parent)
    const liveChild = makeSession('side-1', { durableId: 'side-1' })
    harness.add(liveChild)
    harness.history.set(
      [
        historyEntry('side-1', { sideTaskOf: 'd1' }),
        historyEntry('side-1a', { sideTaskOf: 'side-1' }),
        historyEntry('other', { sideTaskOf: 'd9' }),
      ],
      undefined,
    )

    await expect(harness.service.deleteSideTask('s1', 'side-1')).resolves.toEqual({
      ok: true,
      value: undefined,
    })
    expect(harness.historyService.removeDeleted).toHaveBeenCalledWith('side-1')
    expect(harness.historyService.removeDeleted).toHaveBeenCalledWith('side-1a')
    expect(harness.sessionService.closeSession).toHaveBeenCalledWith('side-1')
    expect(harness.sessionService.deleteOnAgent).toHaveBeenCalledWith('side-1')
    expect(harness.sessionService.deleteOnAgent).toHaveBeenCalledWith('side-1a')
    expect(harness.sessionService.deleteOnAgent).not.toHaveBeenCalledWith('other')

    await expect(harness.service.deleteSideTask('s1', 'other')).resolves.toMatchObject({
      ok: false,
      code: 'invalid_anchor',
    })
  })
})

describe('MobileBridgeService permission supersede', () => {
  it('clears the replaced request before broadcasting the new one', async () => {
    vi.useFakeTimers()
    try {
      const harness = makeHarness()
      const first = makeSession('s1')
      harness.add(first)
      await harness.service.startStreaming()
      first.pendingPermission.set(
        {
          requestId: 'req-1',
          toolCallId: 'tool-1',
          title: 'First',
          options: [{ optionId: 'allow-once', name: 'Allow' }],
          resolve: () => {},
          cancel: () => {},
          resolveWithSource: () => {},
          cancelWithSource: () => {},
        },
        undefined,
      )
      await flush()
      harness.events.length = 0

      // Mirrors presentPermission(): clear the old card, settle it as
      // superseded, then present the replacement.
      first.pendingPermission.set(undefined, undefined)
      first.settlePermission({
        requestId: 'req-1',
        outcome: 'cancelled',
        source: 'pc',
        reason: 'superseded',
      })
      first.pendingPermission.set(
        {
          requestId: 'req-2',
          toolCallId: 'tool-2',
          title: 'Second',
          options: [{ optionId: 'allow-once', name: 'Allow' }],
          resolve: () => {},
          cancel: () => {},
          resolveWithSource: () => {},
          cancelWithSource: () => {},
        },
        undefined,
      )
      await flush()

      const events = harness.events
        .filter(
          (event): event is Extract<MobileBridgeEvent, { kind: 'session_delta' }> =>
            event.kind === 'session_delta',
        )
        .flatMap((event) => event.events)
        .filter(
          (event) => event.type === 'permission_cleared' || event.type === 'permission_upsert',
        )
      expect(events).toStrictEqual([
        {
          type: 'permission_cleared',
          requestId: 'req-1',
          reason: 'superseded',
          source: 'pc',
        },
        expect.objectContaining({
          type: 'permission_upsert',
          permission: expect.objectContaining({ requestId: 'req-2' }),
        }),
      ])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('MobileBridgeService attention', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('emits attention edges without starting the streaming pipeline', async () => {
    const harness = makeHarness()
    const first = makeSession('s1', { title: 'Parsed title', durableId: 'd1' })
    harness.add(first)

    await harness.service.startAttention()
    first.status.set('running', undefined)
    first.pendingPermission.set(
      {
        requestId: 'r1',
        toolCallId: 't1',
        title: 'Run shell command',
        options: [],
      } as unknown as AcpPendingPermission,
      undefined,
    )
    first.status.set('idle', undefined)

    expect(harness.events).toEqual([
      {
        kind: 'attention',
        localId: 's1',
        durableId: 'd1',
        attentionKind: 'permission',
        title: 'Parsed title',
        agentName: 'Fake Agent',
        permissionTitle: 'Run shell command',
      },
    ])
    expect(first.timeline.get()).toEqual([])
  })

  it('debounces completion and stops after stopAttention', async () => {
    const harness = makeHarness()
    const first = makeSession('s1')
    harness.add(first)
    await harness.service.startAttention()

    first.status.set('running', undefined)
    first.status.set('idle', undefined)
    expect(harness.events).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(300)
    expect(harness.events).toEqual([
      {
        kind: 'attention',
        localId: 's1',
        attentionKind: 'completed',
        title: 'Session s1',
        agentName: 'Fake Agent',
      },
    ])

    await harness.service.stopAttention()
    harness.events.length = 0
    first.pendingElicitation.set({ request: {} } as unknown as AcpPendingElicitation, undefined)
    expect(harness.events).toHaveLength(0)
  })

  it('stops attention when the bridge is disposed', async () => {
    const harness = makeHarness()
    const first = makeSession('s1')
    harness.add(first)
    await harness.service.startAttention()

    harness.service.dispose()
    first.pendingElicitation.set({ request: {} } as unknown as AcpPendingElicitation, undefined)
    expect(harness.events).toHaveLength(0)
  })
})

describe('MobileBridgeService workspace git state', () => {
  function sourceControl(id: string, count: number | undefined): IScmSourceControlModel {
    return {
      id,
      count: observableValue<number | undefined>('test.scmCount', count),
    } as unknown as IScmSourceControlModel
  }

  it('returns undefined when no git provider has reported a count', async () => {
    const harness = makeHarness()
    await expect(harness.service.getWorkspaceGitDirty()).resolves.toBeUndefined()

    harness.scmSourceControls.set([sourceControl('git', undefined)], undefined)
    await expect(harness.service.getWorkspaceGitDirty()).resolves.toBeUndefined()
  })

  it('reports clean when every git provider counts zero', async () => {
    const harness = makeHarness()
    harness.scmSourceControls.set([sourceControl('git', 0), sourceControl('git', 0)], undefined)
    await expect(harness.service.getWorkspaceGitDirty()).resolves.toBe(false)
  })

  it('reports dirty when any git provider has changes', async () => {
    const harness = makeHarness()
    harness.scmSourceControls.set([sourceControl('git', 0), sourceControl('git', 3)], undefined)
    await expect(harness.service.getWorkspaceGitDirty()).resolves.toBe(true)
  })

  it('ignores non-git providers', async () => {
    const harness = makeHarness()
    harness.scmSourceControls.set([sourceControl('perforce', 5)], undefined)
    await expect(harness.service.getWorkspaceGitDirty()).resolves.toBeUndefined()
  })
})

describe('MobileBridgeService image bytes', () => {
  function imageMessage(blocks: AcpMessage['blocks'], id = 'm1'): AcpMessage {
    return { id, role: 'agent', text: '', blocks, streaming: false }
  }

  it('returns bytes for the requested ACP image ordinal', async () => {
    const harness = makeHarness()
    const session = makeSession('s1')
    session.messages.set(
      [
        imageMessage([
          { type: 'text', text: 'hi' },
          { type: 'image', data: 'AQID', mimeType: 'image/png' },
          { type: 'image', data: 'BAUG', mimeType: 'image/jpeg' },
        ]),
      ],
      undefined,
    )
    harness.add(session)

    await expect(harness.service.getMessageImage('s1', 'm1', 1)).resolves.toEqual({
      mimeType: 'image/jpeg',
      bytes: new Uint8Array([4, 5, 6]),
    })
    await expect(harness.service.getMessageImage('s1', 'm1', 2)).resolves.toBeUndefined()
    await expect(harness.service.getMessageImage('missing', 'm1', 0)).resolves.toBeUndefined()
    await expect(harness.service.getMessageImage('s1', 'missing', 0)).resolves.toBeUndefined()
    await expect(harness.service.getMessageImage('s1', 'm1', -1)).resolves.toBeUndefined()
  })

  it('does not serve phone attachments, truncated payloads or unsupported types', async () => {
    const harness = makeHarness()
    const session = makeSession('s1')
    session.messages.set(
      [
        imageMessage([
          {
            type: 'image',
            data: 'AQID',
            mimeType: 'image/png',
            _meta: {
              mobileAttachment: {
                id: 'att-1',
                kind: 'image',
                name: 'shot.png',
                mimeType: 'image/png',
                size: 3,
              },
            },
          },
          {
            type: 'image',
            data: '',
            mimeType: 'image/png',
            _meta: { 'universe-editor/truncated': true },
          },
          { type: 'image', data: 'AQID', mimeType: 'image/svg+xml' },
          { type: 'image', data: 'not base64!', mimeType: 'image/png' },
        ]),
      ],
      undefined,
    )
    harness.add(session)

    for (let index = 0; index < 4; index++) {
      await expect(harness.service.getMessageImage('s1', 'm1', index)).resolves.toBeUndefined()
    }
  })

  it('resolves a relative workspace image against the session cwd', async () => {
    const harness = makeHarness()
    const session = makeSession('s1')
    harness.add(session)

    await expect(harness.service.getWorkspaceImage('s1', 'images/shot.png')).resolves.toEqual({
      mimeType: 'image/png',
      bytes: new Uint8Array([1, 2, 3]),
    })
    expect(vi.mocked(harness.files.readFile).mock.calls[0]?.[0].toString()).toBe(
      'file:///workspace/demo/images/shot.png',
    )
  })

  it('tries the percent-decoded variant when the literal path is missing', async () => {
    const harness = makeHarness({
      readFile: vi
        .fn()
        .mockRejectedValueOnce(new Error('ENOENT'))
        .mockResolvedValueOnce(new Uint8Array([7])),
    })
    const session = makeSession('s1')
    harness.add(session)

    await expect(harness.service.getWorkspaceImage('s1', 'images/my%20shot.png')).resolves.toEqual({
      mimeType: 'image/png',
      bytes: new Uint8Array([7]),
    })
    expect(vi.mocked(harness.files.readFile).mock.calls[1]?.[0].toString()).toBe(
      'file:///workspace/demo/images/my%20shot.png',
    )
  })

  it('rejects escapes, other schemes, remote file: paths and unsupported roots', async () => {
    const harness = makeHarness()
    const session = makeSession('s1')
    harness.add(session)

    await expect(
      harness.service.getWorkspaceImage('s1', '../../etc/passwd.png'),
    ).resolves.toBeUndefined()
    await expect(
      harness.service.getWorkspaceImage('s1', '/tmp/outside.png'),
    ).resolves.toBeUndefined()
    await expect(
      harness.service.getWorkspaceImage('s1', '\\\\server\\share\\x.png'),
    ).resolves.toBeUndefined()
    await expect(
      harness.service.getWorkspaceImage('s1', 'https://example.com/x.png'),
    ).resolves.toBeUndefined()
    await expect(
      harness.service.getWorkspaceImage('s1', 'file:///tmp/outside.png'),
    ).resolves.toBeUndefined()
    await expect(harness.service.getWorkspaceImage('s1', 'notes.txt')).resolves.toBeUndefined()
    await expect(harness.service.getWorkspaceImage('missing', 'shot.png')).resolves.toBeUndefined()
  })

  it('builds remote-ssh resources for remote sessions', async () => {
    const harness = makeHarness()
    const session = makeSession('remote', {
      authority: 'ssh-remote+host',
      cwd: '/home/dev/proj',
    })
    harness.add(session)

    await expect(harness.service.getWorkspaceImage('remote', 'img/shot.png')).resolves.toEqual({
      mimeType: 'image/png',
      bytes: new Uint8Array([1, 2, 3]),
    })
    expect(vi.mocked(harness.files.readFile).mock.calls[0]?.[0].toString()).toBe(
      'remote-ssh://ssh-remote+host/home/dev/proj/img/shot.png',
    )
    await expect(
      harness.service.getWorkspaceImage('remote', 'file:///home/dev/proj/img/shot.png'),
    ).resolves.toBeUndefined()
  })

  it('rejects oversized files before reading them', async () => {
    const harness = makeHarness({
      stat: vi.fn(async (resource: URI) => ({
        resource,
        isFile: true,
        isDirectory: false,
        size: 17 * 1024 * 1024,
        mtime: 0,
      })),
    })
    const session = makeSession('s1')
    harness.add(session)

    await expect(harness.service.getWorkspaceImage('s1', 'shot.png')).resolves.toBeUndefined()
    expect(vi.mocked(harness.files.readFile)).not.toHaveBeenCalled()
  })

  it('re-checks the real path so symlinks cannot escape the cwd', async () => {
    const harness = makeHarness({
      realpath: vi.fn(async (uri: URI) =>
        uri.fsPath.endsWith('.png') ? URI.file('/etc/passwd.png') : uri,
      ),
    })
    const session = makeSession('s1')
    harness.add(session)

    await expect(harness.service.getWorkspaceImage('s1', 'shot.png')).resolves.toBeUndefined()
  })

  it('allows a symlinked cwd when the real paths still nest', async () => {
    const harness = makeHarness({
      realpath: vi.fn(async (uri: URI) => {
        if (uri.fsPath === '/workspace/demo') return URI.file('/mnt/real')
        if (uri.fsPath === '/workspace/demo/shot.png') return URI.file('/mnt/real/shot.png')
        return uri
      }),
    })
    const session = makeSession('s1')
    harness.add(session)

    await expect(harness.service.getWorkspaceImage('s1', 'shot.png')).resolves.toEqual({
      mimeType: 'image/png',
      bytes: new Uint8Array([1, 2, 3]),
    })
    expect(vi.mocked(harness.files.readFile).mock.calls[0]?.[0].toString()).toBe(
      'file:///mnt/real/shot.png',
    )
  })
})

describe('MobileBridgeService deliveries', () => {
  const deliverySummary = {
    deliveryId: 'del-1',
    phase: 'awaiting_push' as const,
    commitCount: 1,
    dirtySource: false,
    mainBranch: 'main',
    updatedAt: 5,
    canConfirmPush: true,
    canRetry: false,
    canUndo: true,
    sync: { synced: 0, upToDate: 0, skipped: 0, failed: 0 },
  }

  it('projects the active delivery into session summaries', async () => {
    const harness = makeHarness()
    harness.add(makeSession('s1', { durableId: 'd1' }))
    vi.mocked(harness.delivery.getSummaryForSession).mockReturnValue(deliverySummary)
    vi.mocked(harness.delivery.isAvailable).mockReturnValue(true)
    vi.mocked(harness.delivery.hasDeliverableChanges).mockReturnValue(true)

    await expect(harness.service.listSessions()).resolves.toMatchObject([
      { localId: 's1', delivery: deliverySummary, deliveryAvailable: true },
    ])
  })

  it('keeps delivery fields on streamed inbox upserts', async () => {
    vi.useFakeTimers()
    try {
      const harness = makeHarness()
      harness.add(makeSession('s1', { durableId: 'd1' }))
      vi.mocked(harness.delivery.getSummaryForSession).mockReturnValue(deliverySummary)
      vi.mocked(harness.delivery.isAvailable).mockReturnValue(true)
      vi.mocked(harness.delivery.hasDeliverableChanges).mockReturnValue(true)

      await harness.service.startStreaming()
      await flush()

      const upserts = harness.events.flatMap((event) =>
        event.kind === 'inbox' ? event.upserts : [],
      )
      expect(upserts.at(-1)).toMatchObject({
        localId: 's1',
        delivery: deliverySummary,
        deliveryAvailable: true,
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('restores delivery availability when a running session finishes', async () => {
    vi.useFakeTimers()
    try {
      const harness = makeHarness()
      const session = makeSession('s1', { durableId: 'd1' })
      harness.add(session)
      vi.mocked(harness.delivery.getSummaryForSession).mockReturnValue(deliverySummary)
      vi.mocked(harness.delivery.isAvailable).mockReturnValue(false)
      session.status.set('running', undefined)

      await harness.service.startStreaming()
      await flush()

      const latestUpsert = () =>
        harness.events.flatMap((event) => (event.kind === 'inbox' ? event.upserts : [])).at(-1)
      expect(latestUpsert()?.deliveryAvailable).toBeUndefined()

      vi.mocked(harness.delivery.isAvailable).mockReturnValue(true)
      vi.mocked(harness.delivery.hasDeliverableChanges).mockReturnValue(true)
      session.status.set('idle', undefined)
      await flush()

      expect(latestUpsert()).toMatchObject({ localId: 's1', deliveryAvailable: true })
    } finally {
      vi.useRealTimers()
    }
  })

  it('offers delivery only when the session is eligible and its worktree has work', async () => {
    const harness = makeHarness()
    harness.add(makeSession('s1', { durableId: 'd1' }))
    vi.mocked(harness.delivery.isAvailable).mockReturnValue(true)
    vi.mocked(harness.delivery.hasDeliverableChanges).mockReturnValue(false)

    const [ineligibleWorktree] = await harness.service.listSessions()
    expect(ineligibleWorktree?.deliveryAvailable).toBeUndefined()

    vi.mocked(harness.delivery.hasDeliverableChanges).mockReturnValue(true)
    const [eligible] = await harness.service.listSessions()
    expect(eligible?.deliveryAvailable).toBe(true)

    vi.mocked(harness.delivery.isAvailable).mockReturnValue(false)
    const [notIdle] = await harness.service.listSessions()
    expect(notIdle?.deliveryAvailable).toBeUndefined()
  })

  it('publishes delivery availability after the background probe finds work', async () => {
    vi.useFakeTimers()
    try {
      const harness = makeHarness()
      harness.add(makeSession('s1', { durableId: 'd1' }))
      vi.mocked(harness.delivery.isAvailable).mockReturnValue(true)
      let settleProbe: ((changed: boolean) => void) | undefined
      let answered = false
      vi.mocked(harness.delivery.refreshDeliverableChanges).mockImplementation(() => {
        if (answered) return Promise.resolve(false)
        return new Promise<boolean>((resolve) => {
          settleProbe = resolve
        })
      })

      const [initial] = await harness.service.listSessions()
      expect(initial?.deliveryAvailable).toBeUndefined()

      vi.mocked(harness.delivery.hasDeliverableChanges).mockReturnValue(true)
      answered = true
      settleProbe?.(true)
      await flush(0)

      const upserts = harness.events.flatMap((event) =>
        event.kind === 'inbox' ? event.upserts : [],
      )
      expect(upserts.at(-1)).toMatchObject({ localId: 's1', deliveryAvailable: true })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not publish when a probe leaves the value unchanged', async () => {
    vi.useFakeTimers()
    try {
      const harness = makeHarness()
      harness.add(makeSession('s1', { durableId: 'd1' }))
      vi.mocked(harness.delivery.isAvailable).mockReturnValue(true)

      await harness.service.listSessions()
      await flush(0)

      expect(harness.events).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('republishes every session sharing the probed worktree', async () => {
    vi.useFakeTimers()
    try {
      const harness = makeHarness()
      harness.add(makeSession('s1', { durableId: 'd1', cwd: '/repo/feature' }))
      harness.add(makeSession('s2', { durableId: 'd2', cwd: '/repo/feature' }))
      harness.add(makeSession('s3', { durableId: 'd3', cwd: '/repo/other' }))
      vi.mocked(harness.delivery.isAvailable).mockReturnValue(true)
      const featureProbe = deferred<boolean>()
      const otherProbe = deferred<boolean>()
      let featureAnswered = false
      vi.mocked(harness.delivery.refreshDeliverableChanges).mockImplementation((session) => {
        if (session.cwd !== '/repo/feature') return otherProbe.promise
        return featureAnswered ? Promise.resolve(false) : featureProbe.promise
      })

      await harness.service.listSessions()
      vi.mocked(harness.delivery.hasDeliverableChanges).mockReturnValue(true)
      featureAnswered = true
      featureProbe.resolve(true)
      await flush(0)

      const published = new Set(
        harness.events.flatMap((event) =>
          event.kind === 'inbox' ? event.upserts.map((summary) => summary.localId) : [],
        ),
      )
      expect(published).toEqual(new Set(['s1', 's2']))
    } finally {
      vi.useRealTimers()
    }
  })

  it('recomputes the summary when the session starts running before the probe lands', async () => {
    vi.useFakeTimers()
    try {
      const harness = makeHarness()
      const session = makeSession('s1', { durableId: 'd1' })
      harness.add(session)
      vi.mocked(harness.delivery.isAvailable).mockImplementation(
        () => session.status.get() === 'idle',
      )
      vi.mocked(harness.delivery.hasDeliverableChanges).mockReturnValue(true)
      let settleProbe: ((changed: boolean) => void) | undefined
      let answered = false
      vi.mocked(harness.delivery.refreshDeliverableChanges).mockImplementation(() => {
        if (answered) return Promise.resolve(false)
        return new Promise<boolean>((resolve) => {
          settleProbe = resolve
        })
      })

      await harness.service.listSessions()
      session.status.set('running', undefined)
      answered = true
      settleProbe?.(true)
      await flush(0)

      const upserts = harness.events.flatMap((event) =>
        event.kind === 'inbox' ? event.upserts : [],
      )
      expect(upserts.at(-1)?.deliveryAvailable).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('forces a probe when a running session becomes idle', async () => {
    vi.useFakeTimers()
    try {
      const harness = makeHarness()
      const session = makeSession('s1', { durableId: 'd1' })
      harness.add(session)
      vi.mocked(harness.delivery.isAvailable).mockImplementation(
        () => session.status.get() === 'idle',
      )
      session.status.set('running', undefined)
      await harness.service.startStreaming()
      await flush()
      vi.mocked(harness.delivery.refreshDeliverableChanges).mockClear()

      session.status.set('idle', undefined)
      await flush()

      expect(harness.delivery.refreshDeliverableChanges).toHaveBeenCalledWith(
        expect.objectContaining({ id: 's1' }),
        { force: true },
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('forces a probe when a delivery record changes', () => {
    const harness = makeHarness()
    harness.add(makeSession('s1', { durableId: 'd1' }))
    vi.mocked(harness.delivery.isAvailable).mockReturnValue(true)

    harness.deliveryChanges.fire({ deliveryId: 'del-1', sessionLocalId: 's1' })

    expect(harness.delivery.refreshDeliverableChanges).toHaveBeenCalledWith(
      expect.objectContaining({ id: 's1' }),
      { force: true },
    )
  })

  it('sweeps eligible worktrees while streaming and stops afterwards', async () => {
    vi.useFakeTimers()
    try {
      const harness = makeHarness()
      harness.add(makeSession('s1', { durableId: 'd1' }))
      vi.mocked(harness.delivery.isAvailable).mockReturnValue(true)
      await harness.service.startStreaming()
      await flush()
      vi.mocked(harness.delivery.refreshDeliverableChanges).mockClear()

      await vi.advanceTimersByTimeAsync(MOBILE_PENDING_WORK_SWEEP_MS)
      expect(harness.delivery.refreshDeliverableChanges).toHaveBeenCalled()

      await harness.service.stopStreaming()
      vi.mocked(harness.delivery.refreshDeliverableChanges).mockClear()
      await vi.advanceTimersByTimeAsync(MOBILE_PENDING_WORK_SWEEP_MS * 2)
      expect(harness.delivery.refreshDeliverableChanges).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('routes preview/start to the delivery service and strips absolute paths', async () => {
    const harness = makeHarness()
    harness.add(makeSession('s1', { durableId: 'd1' }))
    const expectation = {
      mainHead: 'm1',
      mainBranch: 'main',
      targetBranch: 'main',
      remote: 'origin',
      remoteBranch: 'main',
      upstreamRef: 'origin/main',
      upstreamHead: 'u1',
      sourceHead: 's1',
      baseSha: 'b1',
      commits: [],
    }
    const preview: SessionDeliveryPreview = {
      source: {
        worktree: 'D:/repo/feature',
        branch: 'feature',
        head: 's1',
        dirty: false,
        changedFileCount: 0,
        untrackedCount: 0,
        isMainWorktree: false,
      },
      target: {
        mainWorktree: 'D:/repo/main',
        mainBranch: 'main',
        targetBranch: 'main',
        remote: 'origin',
        remoteBranch: 'main',
        upstreamRef: 'origin/main',
        baseSha: 'b1',
        upstreamHead: 'u1',
        aheadOfUpstream: 1,
      },
      commits: [],
      blockers: [],
      warnings: [],
      forkSupported: true,
      expectation,
    }
    vi.mocked(harness.delivery.preview).mockResolvedValue({ ok: true, preview })

    const result = await harness.service.previewDelivery('s1', 'd1')
    expect(harness.delivery.preview).toHaveBeenCalledWith('s1')
    expect(result).toMatchObject({
      ok: true,
      value: {
        source: { worktreeName: 'feature' },
        target: { mainWorktreeName: 'main' },
      },
    })
    expect(JSON.stringify(result)).not.toContain('D:/repo')

    vi.mocked(harness.delivery.startInBackground).mockResolvedValue({
      ok: true,
      value: { deliveryId: 'del-1' },
    })
    await expect(harness.service.startDelivery('s1', expectation, 'd1')).resolves.toEqual({
      ok: true,
      value: { deliveryId: 'del-1' },
    })
    expect(harness.delivery.startInBackground).toHaveBeenCalledWith('s1', expectation)

    vi.mocked(harness.delivery.getRecord).mockReturnValue({
      source: { sessionLocalId: 's1', sessionDurableId: 'd1' },
    } as unknown as ReturnType<ISessionDeliveryService['getRecord']>)
    vi.mocked(harness.delivery.confirmPushInBackground).mockResolvedValue({
      ok: true,
      value: undefined,
    })
    await expect(harness.service.confirmDeliveryPush('s1', 'del-1')).resolves.toEqual({
      ok: true,
      value: undefined,
    })
    expect(harness.delivery.confirmPushInBackground).toHaveBeenCalledWith('del-1')
    expect(harness.delivery.confirmPush).not.toHaveBeenCalled()
  })

  it('rejects delivery commands for unknown sessions and foreign delivery ids', async () => {
    const harness = makeHarness()
    harness.add(makeSession('s1', { durableId: 'd1' }))

    await expect(harness.service.previewDelivery('missing')).resolves.toMatchObject({
      ok: false,
      code: 'session_not_found',
    })
    vi.mocked(harness.delivery.getRecord).mockReturnValue({
      source: { sessionLocalId: 'other' },
    } as unknown as ReturnType<ISessionDeliveryService['getRecord']>)
    await expect(harness.service.getDelivery('s1', 'del-1')).resolves.toMatchObject({
      ok: false,
      code: 'delivery_not_found',
    })
  })

  it('blocks prompts and new sessions while a delivery holds the worktree', async () => {
    const harness = makeHarness()
    harness.add(makeSession('s1', { durableId: 'd1' }))
    vi.mocked(harness.delivery.isDeliveryBusyForSession).mockReturnValue(true)
    vi.mocked(harness.delivery.isDeliveryBusyForCwd).mockReturnValue(true)

    await expect(harness.service.sendPrompt('s1', 'hello')).resolves.toMatchObject({
      ok: false,
      code: 'delivery_busy',
    })
    await expect(
      harness.service.newSession('fake', { folder: 'file:///workspace/demo' }, null),
    ).resolves.toMatchObject({ ok: false, code: 'delivery_busy' })
  })

  it('refuses to delete a session whose delivery is still active', async () => {
    const harness = makeHarness()
    harness.add(makeSession('s1', { durableId: 'd1' }))
    vi.mocked(harness.delivery.isDeliveryBusyForSession).mockReturnValue(true)

    await expect(harness.service.deleteSession('s1')).resolves.toMatchObject({
      ok: false,
      code: 'delivery_busy',
    })
  })

  it('strips raw git error details and clips long messages before sending', async () => {
    const harness = makeHarness()
    harness.add(makeSession('s1', { durableId: 'd1' }))
    vi.mocked(harness.delivery.getRecord).mockReturnValue({
      source: { sessionLocalId: 's1', sessionDurableId: 'd1' },
    } as unknown as ReturnType<ISessionDeliveryService['getRecord']>)
    vi.mocked(harness.delivery.getDetail).mockReturnValue({
      summary: {
        ...deliverySummary,
        error: {
          code: 'git_failed',
          message: 'x'.repeat(400),
          detail: 'D:/secret/repo/.git delivery stderr',
        },
      },
      source: { worktreeName: 'feature', head: 's1', dirty: false },
      target: {
        mainWorktreeName: 'main',
        mainBranch: 'main',
        remote: 'origin',
        remoteBranch: 'main',
        upstreamRef: 'origin/main',
        baseSha: 'b1',
        mainHead: 'm1',
      },
      commits: [],
      conflictFiles: [],
      syncResults: [],
    })

    const result = await harness.service.getDelivery('s1', 'del-1')
    expect(result.ok).toBe(true)
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('D:/secret/repo')
    expect(serialized).not.toContain('x'.repeat(400))
    if (result.ok) {
      expect(result.value.summary.error?.message).toHaveLength(300)
    }
  })
})
