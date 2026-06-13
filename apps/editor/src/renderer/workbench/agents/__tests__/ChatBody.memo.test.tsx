/*---------------------------------------------------------------------------------------------
 *  Regression test for the TimelineSlot memoization: a streaming update that only
 *  changes the tail slot must NOT re-render the settled slots above it. Without
 *  React.memo every 16ms timeline.set() re-ran all N slots — the source of the
 *  lag when the timeline grows. We mock MessageContent with a render counter and
 *  assert unchanged slots stay put while only the tail re-renders.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import {
  Event,
  IConfigurationService,
  IFileSearchService,
  IFileService,
  InstantiationService,
  IWorkspaceService,
  observableValue,
  ServiceCollection,
  type ISettableObservable,
} from '@universe-editor/platform'
import type {
  IFileSearchService as IFileSearchServiceType,
  IFileService as IFileServiceType,
  IWorkspaceService as IWorkspaceServiceType,
} from '@universe-editor/platform'
import type {
  AcpMessage,
  AcpPendingPermission,
  AcpPlanEntry,
  AcpSessionStatus,
  AcpToolCall,
  AcpUsage,
  IAcpSession,
  TimelineItem,
} from '../../../services/acp/acpSessionService.js'
import { IAcpSessionService } from '../../../services/acp/acpSessionService.js'
import { IAcpAgentRegistry } from '../../../services/acp/acpAgentRegistry.js'
import { IAcpChatWidgetService } from '../../../services/acp/acpChatWidgetService.js'
import { AcpChatViewStateCache } from '../../../services/acp/acpChatViewStateCache.js'
import type { SessionConfigOption, ContentBlock } from '@agentclientprotocol/sdk'
import { ServicesContext } from '../../useService.js'

// Replace MessageContent with a counter keyed by its first text block so we can
// detect exactly which slots re-rendered.
const renderCounts = new Map<string, number>()
vi.mock('../MessageContent.js', () => ({
  MessageContent: ({ blocks }: { blocks: readonly ContentBlock[] }) => {
    const first = blocks.find((b) => b.type === 'text')
    const key = first && first.type === 'text' ? first.text : '<empty>'
    renderCounts.set(key, (renderCounts.get(key) ?? 0) + 1)
    return null
  },
}))

// Import after the mock is registered.
const { ChatBody } = await import('../ChatBody.js')

beforeEach(() => {
  renderCounts.clear()
})

afterEach(() => {
  cleanup()
  AcpChatViewStateCache._resetForTests()
})

function makeAgentMessage(id: string, text: string): TimelineItem {
  const message: AcpMessage = {
    id,
    role: 'agent',
    text,
    blocks: [{ type: 'text', text }],
    streaming: false,
  }
  return { kind: 'message', id, message }
}

function makeSession(
  id: string,
  items: readonly TimelineItem[],
): { session: IAcpSession; timeline: ISettableObservable<readonly TimelineItem[]> } {
  const timeline = observableValue<readonly TimelineItem[]>('t.timeline', items)
  const session = {
    id,
    agentId: 'fake',
    title: 'Fake',
    messages: observableValue<readonly AcpMessage[]>('t.messages', []),
    toolCalls: observableValue<readonly AcpToolCall[]>('t.toolCalls', []),
    plan: observableValue<readonly AcpPlanEntry[]>('t.plan', []),
    timeline,
    status: observableValue<AcpSessionStatus>('t.status', 'idle'),
    usage: observableValue<AcpUsage | undefined>('t.usage', undefined),
    pendingPermission: observableValue<AcpPendingPermission | undefined>('t.perm', undefined),
    pendingQuestion: observableValue('t.question', undefined),
    configOptions: observableValue<readonly SessionConfigOption[]>('t.cfg', []),
    availableCommands: observableValue('t.cmds', []),
    presentPermission: () => {},
    presentQuestion: () => {},
    sendPrompt: vi.fn().mockResolvedValue(undefined),
    cancelTurn: vi.fn().mockResolvedValue(undefined),
    close: () => Promise.resolve(),
    setConfigOption: () => Promise.resolve(),
    mcpServers: observableValue('t.mcpServers', []),
    collapseMode: observableValue('t.collapseMode', 'default' as const),
    accumulatedRunningMs: observableValue('t.arm', 0),
    runningStartedAt: observableValue<number | undefined>('t.rsa', undefined),
    cycleCollapseMode: () => {},
  } as unknown as IAcpSession
  return { session, timeline }
}

const stubFileService = {
  _serviceBrand: undefined,
  async listRecursive() {
    return []
  },
} as unknown as IFileServiceType

const stubFileSearch = {
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

const stubWorkspaceService = {
  _serviceBrand: undefined,
  current: null,
  onDidChangeWorkspace: Event.None,
  recent: [],
  onDidChangeRecent: Event.None,
} as unknown as IWorkspaceServiceType

function makeInstantiation(threshold?: number) {
  const services = new ServiceCollection()
  services.set(IAcpSessionService, {
    _serviceBrand: undefined,
    activeSession: observableValue<IAcpSession | undefined>('t.active', undefined),
  } as unknown as IAcpSessionService)
  services.set(IAcpAgentRegistry, {
    _serviceBrand: undefined,
    defaultAgentId: () => 'fake',
  } as unknown as IAcpAgentRegistry)
  services.set(IAcpChatWidgetService, {
    _serviceBrand: undefined,
    lastFocusedWidget: undefined,
    register: () => ({ dispose() {} }),
  } as unknown as IAcpChatWidgetService)
  services.set(IFileService, stubFileService)
  services.set(IFileSearchService, stubFileSearch)
  services.set(IWorkspaceService, stubWorkspaceService)
  services.set(IConfigurationService, {
    _serviceBrand: undefined,
    get: (key: string) =>
      key === 'workbench.chat.virtualizationThreshold' ? threshold : undefined,
    onDidChangeConfiguration: Event.None,
  } as unknown as IConfigurationService)
  return new InstantiationService(services)
}

function renderChat(session: IAcpSession, threshold?: number) {
  const inst = makeInstantiation(threshold)
  return render(
    <ServicesContext.Provider value={inst}>
      <ChatBody session={session} />
    </ServicesContext.Provider>,
  )
}

describe('ChatBody — TimelineSlot memoization', () => {
  it('re-renders only the changed tail slot when the timeline updates', () => {
    const head = [
      makeAgentMessage('a', 'msg-a'),
      makeAgentMessage('b', 'msg-b'),
      makeAgentMessage('c', 'msg-c'),
    ]
    const tailV1 = makeAgentMessage('tail', 'tail-v1')
    const { session, timeline } = makeSession('s1', [...head, tailV1])
    renderChat(session)

    // Every slot rendered exactly once on mount.
    expect(renderCounts.get('msg-a')).toBe(1)
    expect(renderCounts.get('msg-b')).toBe(1)
    expect(renderCounts.get('msg-c')).toBe(1)
    expect(renderCounts.get('tail-v1')).toBe(1)

    // Streaming chunk: only the tail item gets a new object reference; the head
    // slots keep their identity (mirrors acpSession's _upsert*InTimeline slice).
    const tailV2 = makeAgentMessage('tail', 'tail-v2')
    act(() => {
      timeline.set([...head, tailV2], undefined)
    })

    // Head slots were skipped by React.memo — counts unchanged.
    expect(renderCounts.get('msg-a')).toBe(1)
    expect(renderCounts.get('msg-b')).toBe(1)
    expect(renderCounts.get('msg-c')).toBe(1)
    // Only the tail re-rendered.
    expect(renderCounts.get('tail-v2')).toBe(1)
  })
})

describe('ChatBody — virtualization threshold', () => {
  it('switches to a spacer-backed virtual container past the threshold', () => {
    const items = [
      makeAgentMessage('a', 'msg-a'),
      makeAgentMessage('b', 'msg-b'),
      makeAgentMessage('c', 'msg-c'),
    ]
    const { session } = makeSession('s1', items)
    // threshold 2 < 3 items → virtual mode.
    const { container } = renderChat(session, 2)

    const list = container.querySelector<HTMLElement>('[data-testid="acp-timeline"]')!
    // Virtual container is a positioned spacer (a <div>, not the plain <ol>).
    expect(list.tagName).toBe('DIV')
    expect(list.style.position).toBe('relative')
    // happy-dom has no layout engine, so the virtualizer renders 0 rows but still
    // sizes the spacer from estimateRow. A single-line agent message estimates at
    // 60 + 1×21 = 81px, × 3 = 243px.
    expect(list.style.height).toBe('243px')
  })

  it('stays on the plain <ol> list below the threshold', () => {
    const items = [makeAgentMessage('a', 'msg-a'), makeAgentMessage('b', 'msg-b')]
    const { session } = makeSession('s1', items)
    const { container } = renderChat(session, 5)
    const list = container.querySelector<HTMLElement>('[data-testid="acp-timeline"]')!
    expect(list.tagName).toBe('OL')
  })
})
