/*---------------------------------------------------------------------------------------------
 *  Tests for ChatBody / ChatScroll — mouse click selects a timeline item (so
 *  Alt+J/K navigate relative to it) and the focused item survives an unmount →
 *  remount cycle via AcpChatViewStateCache (editor-tab / session switch).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StrictMode } from 'react'
import { render, cleanup, act, fireEvent } from '@testing-library/react'
import {
  Action2,
  Event,
  IConfigurationService,
  ICommandService,
  IContextKeyService,
  ContextKeyService,
  IEditorGroupsService,
  type IEditorGroupsService as IEditorGroupsServiceType,
  IEditorResolverService,
  IFileSearchService,
  IFileService,
  InstantiationService,
  IWorkspaceService,
  MenuId,
  observableValue,
  registerAction2,
  ServiceCollection,
  localize2,
  type ServicesAccessor,
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
  SelectionContext,
  TimelineItem,
} from '../../../services/acp/session/acpSessionService.js'
import { IAcpSessionService } from '../../../services/acp/session/acpSessionService.js'
import {
  IAcpSessionHistoryService,
  type AcpSessionHistoryEntry,
  type IAcpSessionHistoryService as IAcpSessionHistoryServiceType,
} from '../../../services/acp/session/acpSessionHistory.js'
import { IAcpAgentRegistry } from '../../../services/acp/acpAgentRegistry.js'
import {
  IAcpChatWidgetService,
  type AcpChatWidget,
  type IAcpChatWidgetService as IAcpChatWidgetServiceType,
} from '../../../services/acp/session/acpChatWidgetService.js'
import { AcpChatViewStateCache } from '../../../services/acp/session/acpChatViewStateCache.js'
import { AcpSessionOutlineRegistry } from '../../../services/acp/session/acpSessionOutlineRegistry.js'
import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import { ChatBody } from '../ChatBody.js'
import { AcpSessionEditorInput } from '../../../services/acp/session/acpSessionEditorInput.js'
import { ServicesContext } from '../../useService.js'
import { EditorGroupsService } from '../../../services/editor/EditorGroupsService.js'
import styles from '../agents.module.css'
import { IAcpPromptHistoryService } from '../../../services/acp/session/acpPromptHistoryService.js'
import { ISessionBookmarkService } from '../../../services/acp/session/sessionBookmarkService.js'

// All cases here stay below the virtualization threshold, so the virtualizer's
// return value is never used. The real @tanstack/react-virtual, however, attaches
// a scroll listener to the chatBody container and — on the fireEvent.scroll in the
// persistence cases — schedules an isScrollingResetDelay setTimeout that it never
// cancels on unmount. On slower CI that timer fires after happy-dom is torn down,
// crashing in React with "window is not defined". Stub it out entirely.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: () => ({
    getTotalSize: () => 0,
    getVirtualItems: () => [],
    scrollToIndex: () => {},
    measureElement: () => {},
  }),
}))

afterEach(() => {
  cleanup()
  AcpChatViewStateCache._resetForTests()
  AcpSessionOutlineRegistry._resetForTests()
})

const focusedClass = styles['timelineSlotFocused'] as string
const emptySessionClass = styles['chatEmptySession'] as string

class CaptureChatContextArgAction extends Action2 {
  static readonly ID = 'test.acpChatContext.captureArg'
  constructor() {
    super({
      id: CaptureChatContextArgAction.ID,
      title: localize2('test.acpChatContext.captureArg', 'Capture Session Arg'),
      menu: [{ id: MenuId.AcpChatContext, group: 'z_test', order: 1 }],
    })
  }

  override run(_accessor: ServicesAccessor): void {}
}

function makeMessage(id: string, text: string): AcpMessage {
  return { id, role: 'agent', text, blocks: [{ type: 'text', text }], streaming: false }
}

function makeSession(
  id: string,
  items: readonly TimelineItem[],
  opts: {
    isReplayingHistory?: boolean
    forkSupported?: boolean
    status?: AcpSessionStatus
    plan?: readonly AcpPlanEntry[]
  } = {},
): IAcpSession {
  const collapseMode = observableValue<'default' | 'collapsed' | 'expanded'>(
    't.collapse',
    'default',
  )
  return {
    id,
    agentId: 'fake',
    title: 'Fake',
    sessionIdOnAgent: observableValue<string | undefined>('t.sidOnAgent', id),
    messages: observableValue<readonly AcpMessage[]>('t.messages', []),
    toolCalls: observableValue<readonly AcpToolCall[]>('t.toolCalls', []),
    plan: observableValue<readonly AcpPlanEntry[]>('t.plan', opts.plan ?? []),
    timeline: observableValue<readonly TimelineItem[]>('t.timeline', items),
    status: observableValue<AcpSessionStatus>('t.status', opts.status ?? 'idle'),
    isReplayingHistory: observableValue<boolean>('t.replay', opts.isReplayingHistory ?? false),
    usage: observableValue<AcpUsage | undefined>('t.usage', undefined),
    pendingPermission: observableValue<AcpPendingPermission | undefined>('t.perm', undefined),
    pendingElicitation: observableValue('t.elicitation', undefined),
    configOptions: observableValue<readonly SessionConfigOption[]>('t.cfg', []),
    availableCommands: observableValue('t.cmds', []),
    mcpServers: observableValue('t.mcp', []),
    mcpServerSelection: observableValue<readonly string[] | null>('t.mcpSel', null),
    collapseMode,
    accumulatedRunningMs: observableValue('t.arm', 0),
    runningStartedAt: observableValue<number | undefined>('t.rsa', undefined),
    imageSupported: observableValue<boolean>('t.imageSupported', false),
    forkSupported: observableValue<boolean>('t.forkSupported', opts.forkSupported ?? false),
    rewindSupported: observableValue<boolean>('t.rewindSupported', false),
    onDidCancelForRestore: Event.None,
    cycleCollapseMode: () => {
      const cur = collapseMode.get()
      const next = cur === 'default' ? 'collapsed' : cur === 'collapsed' ? 'expanded' : 'default'
      collapseMode.set(next, undefined)
    },
    presentPermission: () => {},
    recoveryState: observableValue('t.recovery', undefined),
    cancelRecovery: () => {},
    retryRecovery: () => Promise.resolve(),
    sendPrompt: vi.fn().mockResolvedValue(undefined),
    cancelTurn: vi.fn().mockResolvedValue(undefined),
    close: () => Promise.resolve(),
    setConfigOption: () => Promise.resolve(),
  } as unknown as IAcpSession
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

interface InstantiationOverrides {
  widget?: Partial<IAcpChatWidgetServiceType>
  history?: Partial<IAcpSessionHistoryServiceType>
  groups?: IEditorGroupsServiceType
}

function makeInstantiation(
  onRegister?: (w: AcpChatWidget) => void,
  onCommand?: (id: string, ...args: unknown[]) => void,
  overrides: InstantiationOverrides = {},
) {
  const services = new ServiceCollection()
  services.set(IContextKeyService, new ContextKeyService())
  services.set(IAcpSessionService, {
    _serviceBrand: undefined,
    activeSession: observableValue<IAcpSession | undefined>('t.active', undefined),
    mcpServerDefinitions: observableValue('t.mcpDefs', []),
    getById: () => undefined,
  } as unknown as IAcpSessionService)
  services.set(IAcpSessionHistoryService, {
    _serviceBrand: undefined,
    entries: observableValue<readonly AcpSessionHistoryEntry[]>('t.sessionHistory', []),
    get: () => undefined,
    ...overrides.history,
  } as unknown as IAcpSessionHistoryService)
  services.set(IEditorGroupsService, overrides.groups ?? new EditorGroupsService())
  services.set(IAcpAgentRegistry, {
    _serviceBrand: undefined,
    defaultAgentId: () => 'fake',
  } as unknown as IAcpAgentRegistry)
  services.set(IAcpChatWidgetService, {
    _serviceBrand: undefined,
    lastFocusedWidget: undefined,
    register: (w: AcpChatWidget) => {
      onRegister?.(w)
      return { dispose() {} }
    },
    focusSessionInput: () => false,
    setHasSelection: () => {},
    setForkSupported: () => {},
    setContextTarget: () => {},
    setPopoverOpen: () => {},
    setFindVisible: () => {},
    ...overrides.widget,
  } as unknown as IAcpChatWidgetService)
  services.set(IEditorResolverService, {
    _serviceBrand: undefined,
    openEditor: () => Promise.resolve(undefined),
  } as unknown as IEditorResolverService)
  services.set(IFileService, stubFileService)
  services.set(IFileSearchService, stubFileSearch)
  services.set(IWorkspaceService, stubWorkspaceService)
  services.set(IConfigurationService, {
    _serviceBrand: undefined,
    get: () => undefined,
    onDidChangeConfiguration: Event.None,
  } as unknown as IConfigurationService)
  services.set(ICommandService, {
    _serviceBrand: undefined,
    executeCommand: (id: string, ...args: unknown[]) => {
      onCommand?.(id, ...args)
      return Promise.resolve(undefined)
    },
  } as unknown as ICommandService)
  services.set(IAcpPromptHistoryService, {
    _serviceBrand: undefined,
    entries: observableValue<readonly string[]>('t.history', []),
    push: () => {},
  } as IAcpPromptHistoryService)
  services.set(ISessionBookmarkService, {
    _serviceBrand: undefined,
    revision: observableValue<number>('t.bookmarks.revision', 0),
    initialize: () => Promise.resolve(),
    toggle: () => {},
    jump: () => {},
    clearActiveSession: () => {},
    bookmarksForSession: () => new Map<string, number>(),
    list: () => [],
  } as unknown as ISessionBookmarkService)
  return new InstantiationService(services)
}

function renderChat(session: IAcpSession) {
  const inst = makeInstantiation()
  return render(
    <ServicesContext.Provider value={inst}>
      <ChatBody session={session} />
    </ServicesContext.Provider>,
  )
}

function renderChatWithWidget(session: IAcpSession) {
  const widgetRef: { current?: AcpChatWidget } = {}
  const inst = makeInstantiation((w) => {
    widgetRef.current = w
  })
  const result = render(
    <ServicesContext.Provider value={inst}>
      <ChatBody session={session} />
    </ServicesContext.Provider>,
  )
  return { ...result, widgetRef }
}

function slotEl(container: HTMLElement, key: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-timeline-key="${key}"]`)
  if (!el) throw new Error(`no slot for ${key}`)
  return el
}

describe('ChatBody — click to focus a timeline item', () => {
  const items: readonly TimelineItem[] = [
    { kind: 'message', id: 'a', message: makeMessage('a', 'first') },
    { kind: 'message', id: 'b', message: makeMessage('b', 'second') },
  ]

  it('marks the clicked timeline item as focused', () => {
    const { container } = renderChat(makeSession('s1', items))
    const second = slotEl(container, 'm:b')
    expect(second.className).not.toContain(focusedClass)
    act(() => {
      fireEvent.click(second)
    })
    expect(slotEl(container, 'm:b').className).toContain(focusedClass)
    expect(slotEl(container, 'm:a').className).not.toContain(focusedClass)
  })

  it('passes the session id to chat context menu commands', () => {
    const disposable = registerAction2(CaptureChatContextArgAction)
    try {
      const command = vi.fn()
      const inst = makeInstantiation(undefined, command)
      const oneMessage: readonly TimelineItem[] = [
        { kind: 'message', id: 'a', message: makeMessage('a', 'first') },
      ]
      const { container, getByText } = render(
        <ServicesContext.Provider value={inst}>
          <ChatBody session={makeSession('s-menu', oneMessage)} />
        </ServicesContext.Provider>,
      )

      fireEvent.contextMenu(slotEl(container, 'm:a'))
      fireEvent.click(getByText('Capture Session Arg'))

      expect(command).toHaveBeenCalledWith(CaptureChatContextArgAction.ID, {
        sessionId: 's-menu',
      })
    } finally {
      disposable.dispose()
    }
  })

  it('pulls DOM focus into the scroll container so Alt+J/K can fire', () => {
    const { container } = renderChat(makeSession('s1', items))
    const scroll = container.querySelector<HTMLElement>(
      '[data-testid="acp-timeline"]',
    )!.parentElement!
    expect(scroll).not.toBe(container.ownerDocument.activeElement)
    act(() => {
      fireEvent.click(slotEl(container, 'm:b'))
    })
    expect(container.ownerDocument.activeElement).toBe(scroll)
  })

  it('restores the focused item after an unmount → remount cycle', () => {
    const session = makeSession('s1', items)
    const first = renderChat(session)
    act(() => {
      fireEvent.click(slotEl(first.container, 'm:b'))
    })
    first.unmount()

    expect(AcpChatViewStateCache.load('s1')?.focusedKey).toBe('m:b')

    const second = renderChat(makeSession('s1', items))
    expect(slotEl(second.container, 'm:b').className).toContain(focusedClass)
  })

  it('does not leak the focused item across different sessions', () => {
    const a = renderChat(makeSession('s1', items))
    act(() => {
      fireEvent.click(slotEl(a.container, 'm:b'))
    })
    a.unmount()

    const b = renderChat(makeSession('s2', items))
    expect(slotEl(b.container, 'm:b').className).not.toContain(focusedClass)
    expect(slotEl(b.container, 'm:a').className).not.toContain(focusedClass)
  })
})

function scrollEl(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>('[data-testid="acp-timeline"]')!.parentElement!
}

describe('ChatBody — context menu fragment targets', () => {
  const CHIP_CONTEXT: SelectionContext = {
    uri: 'file:///w/src/a.ts',
    relPath: 'src/a.ts',
    text: 'const x = 1',
    startLine: 12,
    endLine: 40,
    languageId: 'typescript',
  }

  function makeUserMessage(id: string, text: string): AcpMessage {
    return { id, role: 'user', text, blocks: [{ type: 'text', text }], streaming: false }
  }

  function renderWithCapture(session: IAcpSession, setContextTarget = vi.fn()) {
    const command = vi.fn()
    const inst = makeInstantiation(undefined, command, { widget: { setContextTarget } })
    const result = render(
      <ServicesContext.Provider value={inst}>
        <ChatBody session={session} />
      </ServicesContext.Provider>,
    )
    return { command, setContextTarget, ...result }
  }

  it('resolves an image block as an image target', () => {
    const disposable = registerAction2(CaptureChatContextArgAction)
    try {
      const src = 'data:image/png;base64,QUJD'
      const items: readonly TimelineItem[] = [
        {
          kind: 'message',
          id: 'a',
          message: {
            id: 'a',
            role: 'agent',
            text: '',
            blocks: [{ type: 'image', data: 'QUJD', mimeType: 'image/png' }],
            streaming: false,
          },
        },
      ]
      const { container, getByText, command, setContextTarget } = renderWithCapture(
        makeSession('s-menu', items),
      )

      fireEvent.contextMenu(container.querySelector('[data-testid="acp-image-block"]')!)
      fireEvent.click(getByText('Capture Session Arg'))

      expect(setContextTarget).toHaveBeenCalledWith('image')
      expect(command).toHaveBeenCalledWith(CaptureChatContextArgAction.ID, {
        sessionId: 's-menu',
        target: { kind: 'image', src },
      })
    } finally {
      disposable.dispose()
    }
  })

  it('resolves a resource link as a path target', () => {
    const disposable = registerAction2(CaptureChatContextArgAction)
    try {
      const items: readonly TimelineItem[] = [
        {
          kind: 'message',
          id: 'a',
          message: {
            id: 'a',
            role: 'agent',
            text: '',
            blocks: [{ type: 'resource_link', uri: 'file:///w/src/a.ts', name: 'a.ts' }],
            streaming: false,
          },
        },
      ]
      const { container, getByText, command, setContextTarget } = renderWithCapture(
        makeSession('s-menu', items),
      )

      fireEvent.contextMenu(container.querySelector('[data-testid="acp-resource-link"]')!)
      fireEvent.click(getByText('Capture Session Arg'))

      expect(setContextTarget).toHaveBeenCalledWith('path')
      expect(command).toHaveBeenCalledWith(CaptureChatContextArgAction.ID, {
        sessionId: 's-menu',
        target: { kind: 'path', uri: 'file:///w/src/a.ts' },
      })
    } finally {
      disposable.dispose()
    }
  })

  it('resolves a selection-context chip as a text target', () => {
    const disposable = registerAction2(CaptureChatContextArgAction)
    try {
      // The first user message renders in the StickyUserMessageBar (outside the
      // scroll container that owns the context-menu handler), so the chip lives
      // on a follow-up user message.
      const items: readonly TimelineItem[] = [
        { kind: 'message', id: 'u1', message: makeUserMessage('u1', 'first') },
        { kind: 'message', id: 'a1', message: makeMessage('a1', 'answer') },
        {
          kind: 'message',
          id: 'u2',
          message: { ...makeUserMessage('u2', 'follow up'), selectionContexts: [CHIP_CONTEXT] },
        },
      ]
      const { container, getByText, command, setContextTarget } = renderWithCapture(
        makeSession('s-menu', items),
      )

      fireEvent.contextMenu(container.querySelector('[data-testid="acp-selection-context-chip"]')!)
      fireEvent.click(getByText('Capture Session Arg'))

      expect(setContextTarget).toHaveBeenCalledWith('text')
      expect(command).toHaveBeenCalledWith(CaptureChatContextArgAction.ID, {
        sessionId: 's-menu',
        target: { kind: 'text', text: CHIP_CONTEXT.text },
      })
    } finally {
      disposable.dispose()
    }
  })

  it('clears the fragment keys when the cursor is on plain text', () => {
    const disposable = registerAction2(CaptureChatContextArgAction)
    try {
      const items: readonly TimelineItem[] = [
        { kind: 'message', id: 'a', message: makeMessage('a', 'plain') },
      ]
      const { container, getByText, command, setContextTarget } = renderWithCapture(
        makeSession('s-menu', items),
      )

      fireEvent.contextMenu(slotEl(container, 'm:a'))
      fireEvent.click(getByText('Capture Session Arg'))

      expect(setContextTarget).toHaveBeenCalledWith(undefined)
      expect(command).toHaveBeenCalledWith(CaptureChatContextArgAction.ID, {
        sessionId: 's-menu',
      })
    } finally {
      disposable.dispose()
    }
  })
})

// Drives the content-growth ResizeObserver: happy-dom's built-in RO never emits,
// so a test captures each live observer's callback + observed node and fires it
// on demand. Restored after each case.
class FakeResizeObserver {
  static instances: Array<{ cb: () => void; nodes: Element[] }> = []
  private readonly rec: { cb: () => void; nodes: Element[] }
  constructor(cb: () => void) {
    this.rec = { cb, nodes: [] }
    FakeResizeObserver.instances.push(this.rec)
  }
  observe(node: Element): void {
    this.rec.nodes.push(node)
  }
  unobserve(): void {}
  disconnect(): void {
    const i = FakeResizeObserver.instances.indexOf(this.rec)
    if (i !== -1) FakeResizeObserver.instances.splice(i, 1)
  }
}

function stubRectHeight(el: Element, height: number): void {
  ;(el as HTMLElement).getBoundingClientRect = (() =>
    ({
      top: 0,
      left: 0,
      right: 0,
      bottom: height,
      width: 0,
      height,
      x: 0,
      y: 0,
      toJSON() {},
    }) as DOMRect) as never
}

describe('ChatBody — re-pin on async content growth', () => {
  const RealRO = globalThis.ResizeObserver

  afterEach(() => {
    globalThis.ResizeObserver = RealRO
    FakeResizeObserver.instances = []
  })

  // Regression for "Edit card only shows half": a card can grow AFTER its
  // timeline mutation — an inline diff streams in, an image decodes, Monaco
  // colorizes — leaving the model (and tailContentSignature) unchanged. Without a
  // content-size observer the view would not re-pin and the tail would sit half
  // below the fold until the next slot bumps timeline.length. Growing the content
  // element's box while stuck must pull the container back to the bottom.
  it('scrolls back to the bottom when the content box grows while pinned', () => {
    globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver
    const items: readonly TimelineItem[] = [
      { kind: 'message', id: 'a', message: makeMessage('a', 'first') },
    ]
    const { container } = renderChat(makeSession('s1', items))
    const scroll = scrollEl(container)
    const content = container.querySelector<HTMLElement>('[data-testid="acp-timeline"]')!

    // Fresh session with no saved state → stuck (bottom-pinned) by default.
    Object.defineProperty(scroll, 'scrollHeight', { value: 2000, configurable: true })
    Object.defineProperty(scroll, 'clientHeight', { value: 300, configurable: true })
    scroll.scrollTop = 0

    // Content grows (e.g. an edit card's inline diff streamed in) with no timeline
    // mutation. Fire the content observer that observed the timeline element.
    stubRectHeight(content, 5000)
    act(() => {
      for (const o of FakeResizeObserver.instances) {
        if (o.nodes.includes(content)) o.cb()
      }
    })

    // scrollToBottomStable pins synchronously on its first frame.
    expect(scroll.scrollTop).toBe(2000)
  })

  it('does not scroll when the content box grows while the user has scrolled up', () => {
    globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver
    const items: readonly TimelineItem[] = [
      { kind: 'message', id: 'a', message: makeMessage('a', 'first') },
    ]
    const { container } = renderChat(makeSession('s1', items))
    const scroll = scrollEl(container)
    const content = container.querySelector<HTMLElement>('[data-testid="acp-timeline"]')!

    // User scrolls up → not stuck.
    Object.defineProperty(scroll, 'scrollHeight', { value: 2000, configurable: true })
    Object.defineProperty(scroll, 'clientHeight', { value: 300, configurable: true })
    scroll.scrollTop = 200
    act(() => {
      fireEvent.scroll(scroll)
    })
    expect(AcpChatViewStateCache.load('s1')?.stuck).toBe(false)

    stubRectHeight(content, 5000)
    act(() => {
      for (const o of FakeResizeObserver.instances) {
        if (o.nodes.includes(content)) o.cb()
      }
    })

    // Position held — growth must not yank a user who scrolled away.
    expect(scroll.scrollTop).toBe(200)
  })
})

describe('ChatBody — re-pin when the turn settles and the fork footer mounts', () => {
  const RealRO = globalThis.ResizeObserver

  afterEach(() => {
    globalThis.ResizeObserver = RealRO
    FakeResizeObserver.instances = []
  })

  // Regression for "fork footer sits half below the fold at turn end": the
  // ForkTipFooter is gated on status === 'idle' and mounts OUTSIDE the observed
  // [data-testid="acp-timeline"] element, so the content-growth observer never
  // sees it. The tail signature is also already stable by the time the status
  // flips (the last chunk arrived first), so without `status` in the re-pin
  // effect's deps nothing re-runs and scrollTop stays where it was before the
  // footer grew the content by ~30px.
  it('re-pins to the bottom when the fork footer mounts on idle while pinned', () => {
    globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver
    const items: readonly TimelineItem[] = [
      { kind: 'message', id: 'a', message: makeMessage('a', 'first') },
    ]
    const session = makeSession('s1', items, { forkSupported: true, status: 'running' })
    const setStatus = (
      session.status as ReturnType<typeof observableValue<AcpSessionStatus>>
    ).set.bind(session.status)
    const { container } = renderChat(session)
    const scroll = scrollEl(container)

    // Footer is gated on idle — hidden while running.
    expect(container.querySelector('[data-testid="acp-fork-tip-footer"]')).toBeNull()

    // Pinned at the bottom of the content as it was mid-turn.
    Object.defineProperty(scroll, 'scrollHeight', { value: 2000, configurable: true })
    Object.defineProperty(scroll, 'clientHeight', { value: 300, configurable: true })
    scroll.scrollTop = 1700

    // Turn settles: footer mounts, growing the scrollable content. happy-dom
    // does not do layout, so model the growth by bumping scrollHeight.
    act(() => {
      Object.defineProperty(scroll, 'scrollHeight', { value: 2030, configurable: true })
      setStatus('idle', undefined)
    })
    expect(container.querySelector('[data-testid="acp-fork-tip-footer"]')).not.toBeNull()

    // scrollToBottomStable pins synchronously on its first frame.
    expect(scroll.scrollTop).toBe(2030)
  })

  it('does not re-pin on idle when the user has scrolled up', () => {
    globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver
    const items: readonly TimelineItem[] = [
      { kind: 'message', id: 'a', message: makeMessage('a', 'first') },
    ]
    const session = makeSession('s1', items, { forkSupported: true, status: 'running' })
    const setStatus = (
      session.status as ReturnType<typeof observableValue<AcpSessionStatus>>
    ).set.bind(session.status)
    const { container } = renderChat(session)
    const scroll = scrollEl(container)

    // User scrolls up mid-turn → not stuck.
    Object.defineProperty(scroll, 'scrollHeight', { value: 2000, configurable: true })
    Object.defineProperty(scroll, 'clientHeight', { value: 300, configurable: true })
    scroll.scrollTop = 200
    act(() => {
      fireEvent.scroll(scroll)
    })
    expect(AcpChatViewStateCache.load('s1')?.stuck).toBe(false)

    act(() => {
      Object.defineProperty(scroll, 'scrollHeight', { value: 2030, configurable: true })
      setStatus('idle', undefined)
    })

    // The footer mounting must not yank a user who scrolled away.
    expect(scroll.scrollTop).toBe(200)
  })
})

describe('ChatBody — timeline keyboard handle', () => {
  const items: readonly TimelineItem[] = [
    { kind: 'message', id: 'a', message: makeMessage('a', 'first') },
    { kind: 'message', id: 'b', message: makeMessage('b', 'second') },
    { kind: 'message', id: 'c', message: makeMessage('c', 'third') },
  ]

  it('moves to first/last item and updates the focused slot', () => {
    const { container, widgetRef } = renderChatWithWidget(makeSession('s1', items))
    const scroll = scrollEl(container)
    Object.defineProperty(scroll, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(scroll, 'clientHeight', { value: 300, configurable: true })
    scroll.scrollTop = 500

    act(() => {
      widgetRef.current!.moveTimeline('first')
    })
    expect(slotEl(container, 'm:a').className).toContain(focusedClass)
    expect(slotEl(container, 'm:c').className).not.toContain(focusedClass)
    expect(scroll.scrollTop).toBe(0)

    act(() => {
      widgetRef.current!.moveTimeline('last')
    })
    expect(slotEl(container, 'm:c').className).toContain(focusedClass)
    expect(slotEl(container, 'm:a').className).not.toContain(focusedClass)
    expect(scroll.scrollTop).toBe(1000)
  })

  it('page scrolling keeps the focused slot unchanged', () => {
    const { container, widgetRef } = renderChatWithWidget(makeSession('s1', items))
    const scroll = scrollEl(container)
    Object.defineProperty(scroll, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(scroll, 'clientHeight', { value: 300, configurable: true })

    act(() => {
      fireEvent.click(slotEl(container, 'm:b'))
    })
    scroll.scrollTop = 400

    act(() => {
      widgetRef.current!.scrollTimeline('pageDown')
    })
    expect(scroll.scrollTop).toBe(700)
    expect(slotEl(container, 'm:b').className).toContain(focusedClass)

    act(() => {
      widgetRef.current!.scrollTimeline('pageUp')
    })
    expect(scroll.scrollTop).toBe(400)
    expect(slotEl(container, 'm:b').className).toContain(focusedClass)
  })

  // The first user message is sliced out of displayTimeline (the sticky bar above
  // the scroll container renders it), but it is part of the keyboard navigation
  // sequence: Alt+Home / repeated Alt+K must reach it, with the bar highlighting.
  it('reaches the first user message pinned in the sticky bar', () => {
    const userItems: readonly TimelineItem[] = [
      {
        kind: 'message',
        id: 'u',
        message: {
          id: 'u',
          role: 'user',
          text: 'top question',
          blocks: [{ type: 'text', text: 'top question' }],
          streaming: false,
        },
      },
      { kind: 'message', id: 'a', message: makeMessage('a', 'answer one') },
      { kind: 'message', id: 'b', message: makeMessage('b', 'answer two') },
    ]
    const { container, widgetRef } = renderChatWithWidget(makeSession('s1', userItems))
    const bar = container.querySelector<HTMLElement>('[data-testid="acp-user-bar"]')!
    expect(bar.getAttribute('data-timeline-key')).toBe('m:u')
    // The focus ring lives on the card (inset from the chat edge), not the
    // full-width bar, so the workbench boundary sash can't paint over it.
    const barCard = container.querySelector<HTMLElement>('[data-testid="acp-user-bar-card"]')!

    // Alt+K all the way up from the bottom stops at the sticky bar, not the row
    // below it — and cannot step past it.
    act(() => {
      widgetRef.current!.moveTimeline('last')
    })
    act(() => {
      widgetRef.current!.moveTimeline('prev')
    })
    act(() => {
      widgetRef.current!.moveTimeline('prev')
    })
    expect(barCard.className).toContain(focusedClass)
    expect(slotEl(container, 'm:a').className).not.toContain(focusedClass)
    act(() => {
      widgetRef.current!.moveTimeline('prev')
    })
    expect(barCard.className).toContain(focusedClass)

    // Copy-focused-message resolves text through the full timeline too.
    expect(widgetRef.current!.getFocusedText()).toBe('top question')

    // Alt+Home lands on the bar directly; Alt+J hands focus back to the first
    // in-list row.
    act(() => {
      widgetRef.current!.moveTimeline('last')
    })
    act(() => {
      widgetRef.current!.moveTimeline('first')
    })
    expect(barCard.className).toContain(focusedClass)
    act(() => {
      widgetRef.current!.moveTimeline('next')
    })
    expect(barCard.className).not.toContain(focusedClass)
    expect(slotEl(container, 'm:a').className).toContain(focusedClass)
  })

  // Regression: Alt+F (toggleCollapse) on the focused first-user bar was a no-op —
  // the bar kept its own private collapse state, blind to ChatScroll's override
  // store. It must fold/expand like any in-list slot, via Alt+F, the chevron,
  // and Ctrl+Alt+F mode cycles alike.
  it('toggleCollapse folds the focused first user message in the sticky bar', () => {
    const userItems: readonly TimelineItem[] = [
      {
        kind: 'message',
        id: 'u',
        message: {
          id: 'u',
          role: 'user',
          text: 'top question',
          blocks: [{ type: 'text', text: 'top question' }],
          streaming: false,
        },
      },
      { kind: 'message', id: 'a', message: makeMessage('a', 'answer one') },
    ]
    const { container, widgetRef } = renderChatWithWidget(makeSession('s1', userItems))
    const barExpanded = (): string | null =>
      slotEl(container, 'm:u').querySelector('button')!.getAttribute('aria-expanded')

    act(() => {
      widgetRef.current!.moveTimeline('first')
    })
    expect(barExpanded()).toBe('true')
    act(() => {
      widgetRef.current!.toggleCollapse()
    })
    expect(barExpanded()).toBe('false')
    // Folded through the shared store, so it persists like any in-list override.
    expect(AcpChatViewStateCache.load('s1')?.collapse?.overrides).toContainEqual(['m:u', true])
    act(() => {
      widgetRef.current!.toggleCollapse()
    })
    expect(barExpanded()).toBe('true')

    // The bar's chevron routes through the same shared store.
    act(() => {
      fireEvent.click(slotEl(container, 'm:u').querySelector('button')!)
    })
    expect(barExpanded()).toBe('false')
    act(() => {
      fireEvent.click(slotEl(container, 'm:u').querySelector('button')!)
    })
    expect(barExpanded()).toBe('true')

    // A mode cycle (Ctrl+Alt+F) folds the bar together with everything else.
    act(() => {
      widgetRef.current!.cycleCollapseMode() // collapsed
    })
    expect(barExpanded()).toBe('false')
  })
})

describe('ChatBody — pinned plan bar keyboard navigation', () => {
  // The plan lives on `session.plan`, outside the timeline, and renders as a
  // pinned bar above the scroll container. It is a keyboard-navigation stop
  // (key `p:plan`) right after the first user message — same treatment as the
  // sticky first-user bar. Regression: Alt+J/K could never land on it and
  // Alt+P no-opped while a plan streamed mid-turn (no switch_mode card).
  const planEntries: readonly AcpPlanEntry[] = [
    { content: 'first step', status: 'completed' },
    { content: 'second step', status: 'in_progress' },
  ]
  const userItem = (id: string, text: string): TimelineItem => ({
    kind: 'message',
    id,
    message: { id, role: 'user', text, blocks: [{ type: 'text', text }], streaming: false },
  })
  const navItems: readonly TimelineItem[] = [
    userItem('u', 'top question'),
    { kind: 'message', id: 'a', message: makeMessage('a', 'answer one') },
    { kind: 'message', id: 'b', message: makeMessage('b', 'answer two') },
  ]
  const planCard = (container: HTMLElement): HTMLElement =>
    container.querySelector<HTMLElement>('[data-testid="acp-plan"]')!
  const userBarCard = (container: HTMLElement): HTMLElement =>
    container.querySelector<HTMLElement>('[data-testid="acp-user-bar-card"]')!

  it('walks first user message → plan bar → in-list items with Alt+J, and back with Alt+K', () => {
    const { container, widgetRef } = renderChatWithWidget(
      makeSession('s-plan-nav', navItems, { plan: planEntries }),
    )

    act(() => {
      widgetRef.current!.moveTimeline('first')
    })
    expect(userBarCard(container).className).toContain(focusedClass)

    act(() => {
      widgetRef.current!.moveTimeline('next')
    })
    expect(planCard(container).className).toContain(focusedClass)
    expect(userBarCard(container).className).not.toContain(focusedClass)

    act(() => {
      widgetRef.current!.moveTimeline('next')
    })
    expect(slotEl(container, 'm:a').className).toContain(focusedClass)
    expect(planCard(container).className).not.toContain(focusedClass)

    // Back up: in-list item → plan bar → user bar, stopping at the top.
    act(() => {
      widgetRef.current!.moveTimeline('prev')
    })
    expect(planCard(container).className).toContain(focusedClass)
    act(() => {
      widgetRef.current!.moveTimeline('prev')
    })
    expect(userBarCard(container).className).toContain(focusedClass)
    act(() => {
      widgetRef.current!.moveTimeline('prev')
    })
    expect(userBarCard(container).className).toContain(focusedClass)
  })

  it('jumpToPlan focuses the pinned plan bar and its text is copyable', () => {
    const { container, widgetRef } = renderChatWithWidget(
      makeSession('s-plan-jump', navItems, { plan: planEntries }),
    )
    act(() => {
      widgetRef.current!.jumpToPlan()
    })
    expect(planCard(container).className).toContain(focusedClass)
    expect(widgetRef.current!.getFocusedText()).toBe('first step\nsecond step')
  })

  it('jumpToPlan still lands on the latest ExitPlanMode card when no plan bar exists', () => {
    const switchModeCall: AcpToolCall = {
      id: 'sw1',
      title: 'Ready to code?',
      kind: 'switch_mode',
      status: 'completed',
      text: '',
      blocks: [],
      diffs: [],
    }
    const items: readonly TimelineItem[] = [
      userItem('u', 'top question'),
      { kind: 'toolCall', id: 'sw1', call: switchModeCall },
    ]
    const { container, widgetRef } = renderChatWithWidget(makeSession('s-plan-fallback', items))
    expect(container.querySelector('[data-testid="acp-plan"]')).toBeNull()
    act(() => {
      widgetRef.current!.jumpToPlan()
    })
    expect(slotEl(container, 't:sw1').className).toContain(focusedClass)
  })

  it('toggleCollapse folds the focused plan bar (Alt+F parity with the user bar)', () => {
    const { container, widgetRef } = renderChatWithWidget(
      makeSession('s-plan-fold', navItems, { plan: planEntries }),
    )
    const planExpanded = (): string | null =>
      planCard(container).querySelector('button')!.getAttribute('aria-expanded')

    act(() => {
      widgetRef.current!.jumpToPlan()
    })
    expect(planExpanded()).toBe('true')
    act(() => {
      widgetRef.current!.toggleCollapse()
    })
    expect(planExpanded()).toBe('false')
    act(() => {
      widgetRef.current!.toggleCollapse()
    })
    expect(planExpanded()).toBe('true')
  })
})

describe('ChatBody — empty session hint', () => {
  it('shows session, prompt, and keyboard hints before the first visible item', () => {
    const { container } = renderChat(makeSession('s1', []))
    expect(container.querySelector('[data-testid="acp-empty-session-hint"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="acp-chat"]')?.className).toContain(
      emptySessionClass,
    )

    const text = container.textContent ?? ''
    expect(text).toContain('New session')
    expect(text).toContain('Resume previous')
    expect(text).toContain('Choose agent')
    expect(text).toContain('Commands')
    expect(text).toContain('Mention files')
    expect(text).toContain('Add context')
    expect(text).toContain('Ctrl+Alt+I')
    expect(text).toContain('Alt+Up/Down')
    expect(text).toContain('Alt+Home/End')
    expect(text).toContain('Ctrl+Alt+F')
  })

  it('hides the hint once a visible user message exists', () => {
    const user: AcpMessage = {
      id: 'u1',
      role: 'user',
      text: 'hello',
      blocks: [{ type: 'text', text: 'hello' }],
      streaming: false,
    }
    const { container } = renderChat(
      makeSession('s1', [{ kind: 'message', id: 'u1', message: user }]),
    )
    expect(container.querySelector('[data-testid="acp-empty-session-hint"]')).toBeNull()
    expect(container.querySelector('[data-testid="acp-timeline"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="acp-chat"]')?.className).not.toContain(
      emptySessionClass,
    )
  })

  it('keeps the hint for settled agent messages with no visible content', () => {
    const hidden = makeMessage('empty-agent', '   ')
    const { container } = renderChat(
      makeSession('s1', [{ kind: 'message', id: hidden.id, message: hidden }]),
    )
    expect(container.querySelector('[data-testid="acp-empty-session-hint"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="acp-timeline"]')).toBeNull()
  })

  it('shows the loading placeholder (not the empty hint) while a resumed session replays history', () => {
    // Repro: on resume the session is registered (getById hits → ChatBody renders)
    // BEFORE session/load replays its history, so the timeline is transiently
    // empty. It must show the "Resuming…" placeholder, not flash the empty-session
    // hint, until the replay populates the timeline.
    const { container } = renderChat(makeSession('s1', [], { isReplayingHistory: true }))
    expect(container.querySelector('[data-testid="acp-session-replaying"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="acp-empty-session-hint"]')).toBeNull()
    // The chat container stays mounted (its ref drives widget registration); the
    // placeholder renders inside it instead of the timeline.
    expect(container.querySelector('[data-testid="acp-chat"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="acp-timeline"]')).toBeNull()
  })

  it('renders the timeline (not the placeholder) once replayed content has landed', () => {
    // Even while the replay flag is still set, any visible timeline content means
    // history has started arriving — render it rather than the spinner.
    const user: AcpMessage = {
      id: 'u1',
      role: 'user',
      text: 'hello',
      blocks: [{ type: 'text', text: 'hello' }],
      streaming: false,
    }
    const { container } = renderChat(
      makeSession('s1', [{ kind: 'message', id: 'u1', message: user }], {
        isReplayingHistory: true,
      }),
    )
    expect(container.querySelector('[data-testid="acp-session-replaying"]')).toBeNull()
    expect(container.querySelector('[data-testid="acp-timeline"]')).not.toBeNull()
  })

  it('runs the existing session action commands from the hint', () => {
    const commands: string[] = []
    const inst = makeInstantiation(undefined, (id) => commands.push(id))
    const { getByText } = render(
      <ServicesContext.Provider value={inst}>
        <ChatBody session={makeSession('s1', [])} />
      </ServicesContext.Provider>,
    )

    fireEvent.click(getByText('New session'))
    fireEvent.click(getByText('Resume previous'))
    fireEvent.click(getByText('Choose agent'))

    expect(commands).toEqual([
      'workbench.action.agent.newSession',
      'workbench.action.agent.resumeSession',
      'workbench.action.agent.selectAgent',
    ])
  })
})

describe('ChatBody — widget registration during resume', () => {
  // Regression for 50d30bd8: resuming a session renders the "Resuming…" loading
  // placeholder while its history replays. The placeholder early-returned BEFORE
  // the `ref={containerRef}` chat container mounted, so the register effect saw a
  // null ref and never registered the widget. Because the effect's deps don't
  // include `isReplayingHistory`, it also never re-ran once the replay finished —
  // leaving `lastFocusedWidget` undefined forever, so Ctrl+Alt+I and every
  // timeline-navigation command went dead for resumed sessions.
  it('registers the chat widget while a resumed session is still replaying history', () => {
    const { widgetRef } = renderChatWithWidget(makeSession('s1', [], { isReplayingHistory: true }))
    expect(widgetRef.current).toBeDefined()
  })

  it('keeps a registered, navigable widget after the replay finishes', () => {
    const session = makeSession('s1', [], { isReplayingHistory: true })
    const { container, widgetRef } = renderChatWithWidget(session)
    act(() => {
      ;(session.timeline as ReturnType<typeof observableValue<readonly TimelineItem[]>>).set(
        [
          { kind: 'message', id: 'a', message: makeMessage('a', 'first') },
          { kind: 'message', id: 'b', message: makeMessage('b', 'second') },
        ],
        undefined,
      )
      ;(session.isReplayingHistory as ReturnType<typeof observableValue<boolean>>).set(
        false,
        undefined,
      )
    })
    expect(widgetRef.current).toBeDefined()
    act(() => {
      widgetRef.current!.moveTimeline('last')
    })
    expect(slotEl(container, 'm:b').className).toContain(focusedClass)
  })
})

describe('ChatBody — scroll position persistence', () => {
  const items: readonly TimelineItem[] = [
    { kind: 'message', id: 'a', message: makeMessage('a', 'first') },
    { kind: 'message', id: 'b', message: makeMessage('b', 'second') },
  ]

  it('persists scrollTop and non-stuck on user scroll', () => {
    const { container } = renderChat(makeSession('s1', items))
    const scroll = scrollEl(container)
    Object.defineProperty(scroll, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(scroll, 'clientHeight', { value: 300, configurable: true })
    scroll.scrollTop = 200
    act(() => {
      fireEvent.scroll(scroll)
    })
    const state = AcpChatViewStateCache.load('s1')
    expect(state?.scrollTop).toBe(200)
    expect(state?.stuck).toBe(false)
  })

  it('records stuck=true when scrolled to the bottom', () => {
    const { container } = renderChat(makeSession('s1', items))
    const scroll = scrollEl(container)
    Object.defineProperty(scroll, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(scroll, 'clientHeight', { value: 300, configurable: true })
    scroll.scrollTop = 700
    act(() => {
      fireEvent.scroll(scroll)
    })
    expect(AcpChatViewStateCache.load('s1')?.stuck).toBe(true)
  })

  it('restores scrollTop on remount when previously non-stuck', () => {
    AcpChatViewStateCache.save('s1', { scrollTop: 150, stuck: false, focusedKey: null })
    const { container } = renderChat(makeSession('s1', items))
    expect(scrollEl(container).scrollTop).toBe(150)
  })

  it('does not force a scrollTop when previously stuck (stays bottom-pinned)', () => {
    AcpChatViewStateCache.save('s1', { scrollTop: 150, stuck: true, focusedKey: null })
    const { container } = renderChat(makeSession('s1', items))
    expect(scrollEl(container).scrollTop).toBe(0)
  })

  // Regression: React detaches the DOM subtree before running the unmount effect
  // cleanup, so in a real browser the scroll container reports scrollTop 0 at that
  // point. The unmount flush must not clobber the position handleScroll already
  // saved with that 0. We simulate the detach by forcing scrollTop to read 0
  // right before unmount (happy-dom otherwise keeps the last value on a detached
  // node, which is why the real bug never surfaced in jsdom-style tests).
  it('keeps the saved scrollTop when the container is detached on unmount', () => {
    const { container, unmount } = renderChat(makeSession('s1', items))
    const scroll = scrollEl(container)
    Object.defineProperty(scroll, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(scroll, 'clientHeight', { value: 300, configurable: true })
    scroll.scrollTop = 150
    act(() => {
      fireEvent.scroll(scroll)
    })
    expect(AcpChatViewStateCache.load('s1')?.scrollTop).toBe(150)

    // Simulate a detached element: scrollTop reads 0.
    Object.defineProperty(scroll, 'scrollTop', { value: 0, configurable: true })
    unmount()

    expect(AcpChatViewStateCache.load('s1')?.scrollTop).toBe(150)
    expect(AcpChatViewStateCache.load('s1')?.stuck).toBe(false)
  })
})

describe('ChatBody — collapse', () => {
  const items: readonly TimelineItem[] = [
    { kind: 'message', id: 'a', message: makeMessage('a', 'first') },
    { kind: 'message', id: 'b', message: makeMessage('b', 'second') },
  ]

  function ariaExpanded(container: HTMLElement, key: string): string | null {
    return slotEl(container, key).querySelector('button')!.getAttribute('aria-expanded')
  }

  it('agent and thought messages both start expanded', () => {
    const thought: AcpMessage = {
      id: 'c',
      role: 'thought',
      text: 'pondering',
      blocks: [{ type: 'text', text: 'pondering' }],
      streaming: false,
    }
    const { container } = renderChat(
      makeSession('s1', [
        { kind: 'message', id: 'a', message: makeMessage('a', 'first') },
        { kind: 'message', id: 'c', message: thought },
      ]),
    )
    expect(ariaExpanded(container, 'm:a')).toBe('true')
    expect(ariaExpanded(container, 'm:c')).toBe('true')
  })

  it('toggleCollapse flips the focused item', () => {
    const { container, widgetRef } = renderChatWithWidget(makeSession('s1', items))
    act(() => {
      fireEvent.click(slotEl(container, 'm:b'))
    })
    expect(ariaExpanded(container, 'm:b')).toBe('true')
    act(() => {
      widgetRef.current!.toggleCollapse()
    })
    expect(ariaExpanded(container, 'm:b')).toBe('false')
    expect(ariaExpanded(container, 'm:a')).toBe('true')
  })

  it('cycleCollapseMode cycles default → all collapsed → all expanded', () => {
    const { container, widgetRef } = renderChatWithWidget(makeSession('s1', items))
    expect(ariaExpanded(container, 'm:a')).toBe('true')
    act(() => {
      widgetRef.current!.cycleCollapseMode() // collapsed
    })
    expect(ariaExpanded(container, 'm:a')).toBe('false')
    expect(ariaExpanded(container, 'm:b')).toBe('false')
    act(() => {
      widgetRef.current!.cycleCollapseMode() // expanded
    })
    expect(ariaExpanded(container, 'm:a')).toBe('true')
    expect(ariaExpanded(container, 'm:b')).toBe('true')
    act(() => {
      widgetRef.current!.cycleCollapseMode() // back to default
    })
    expect(ariaExpanded(container, 'm:a')).toBe('true')
  })

  it('restores the collapse state after an unmount → remount cycle', () => {
    const first = renderChatWithWidget(makeSession('s1', items))
    act(() => {
      fireEvent.click(slotEl(first.container, 'm:b'))
    })
    act(() => {
      first.widgetRef.current!.toggleCollapse()
    })
    expect(ariaExpanded(first.container, 'm:b')).toBe('false')
    first.unmount()

    expect(AcpChatViewStateCache.load('s1')?.collapse?.overrides).toContainEqual(['m:b', true])

    const second = renderChat(makeSession('s1', items))
    expect(ariaExpanded(second.container, 'm:b')).toBe('false')
    expect(ariaExpanded(second.container, 'm:a')).toBe('true')
  })
})

// Regression: the INNER content collapse (a long user message clamped by
// max-height / an execute tool call's terminal output → Expand/Collapse button)
// used component-local useState, so expanding then switching session / tab (an
// unmount → remount) snapped the content back to the clamp. It must persist via
// AcpChatViewStateCache like the outer per-slot fold does.
describe('ChatBody — inner content expansion persistence', () => {
  const RealScrollHeight = Object.getOwnPropertyDescriptor(
    globalThis.HTMLElement.prototype,
    'scrollHeight',
  )

  beforeEach(() => {
    // Force every measured inner box to overflow so the Expand/Collapse toggle
    // renders (happy-dom reports scrollHeight 0 otherwise).
    Object.defineProperty(globalThis.HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => 10000,
    })
  })

  afterEach(() => {
    if (RealScrollHeight) {
      Object.defineProperty(globalThis.HTMLElement.prototype, 'scrollHeight', RealScrollHeight)
    } else {
      delete (globalThis.HTMLElement.prototype as unknown as { scrollHeight?: unknown })
        .scrollHeight
    }
  })

  function makeUserMessage(id: string, text: string): AcpMessage {
    return { id, role: 'user', text, blocks: [{ type: 'text', text }], streaming: false }
  }

  function userToggle(container: HTMLElement, key: string): HTMLButtonElement {
    const btn = slotEl(container, key).querySelector<HTMLButtonElement>(
      '[data-testid="acp-user-message-toggle"]',
    )
    if (!btn) throw new Error(`no user-message toggle for ${key}`)
    return btn
  }

  // The first user message is lifted into the sticky bar (displayTimeline drops
  // it), so keep two and assert on the second, which stays in the list.
  const items: readonly TimelineItem[] = [
    { kind: 'message', id: 'a', message: makeUserMessage('a', 'first user message') },
    {
      kind: 'message',
      id: 'b',
      message: makeUserMessage('b', 'a very long pasted log '.repeat(50)),
    },
  ]

  it('persists a long user message expansion across an unmount → remount cycle', () => {
    const first = renderChat(makeSession('s1', items))
    expect(userToggle(first.container, 'm:b').getAttribute('aria-expanded')).toBe('false')

    act(() => {
      fireEvent.click(userToggle(first.container, 'm:b'))
    })
    expect(userToggle(first.container, 'm:b').getAttribute('aria-expanded')).toBe('true')
    first.unmount()

    expect(AcpChatViewStateCache.load('s1')?.contentExpandedKeys ?? []).toContain('msg:m:b')

    const second = renderChat(makeSession('s1', items))
    expect(userToggle(second.container, 'm:b').getAttribute('aria-expanded')).toBe('true')
  })

  it('collapsing again removes the key so the default (clamped) is restored', () => {
    const first = renderChat(makeSession('s1', items))
    act(() => {
      fireEvent.click(userToggle(first.container, 'm:b'))
    })
    act(() => {
      fireEvent.click(userToggle(first.container, 'm:b'))
    })
    first.unmount()

    expect(AcpChatViewStateCache.load('s1')?.contentExpandedKeys ?? []).not.toContain('msg:m:b')

    const second = renderChat(makeSession('s1', items))
    expect(userToggle(second.container, 'm:b').getAttribute('aria-expanded')).toBe('false')
  })
})

describe('ChatBody — outline controller active-slot sync', () => {
  const items: readonly TimelineItem[] = [
    { kind: 'message', id: 'a', message: makeMessage('a', 'first') },
    { kind: 'message', id: 'b', message: makeMessage('b', 'second') },
    { kind: 'message', id: 'c', message: makeMessage('c', 'third') },
  ]

  it('fires onDidChangeActive and reports the new key when the keyboard selection moves', () => {
    const { widgetRef } = renderChatWithWidget(makeSession('s1', items))
    const controller = AcpSessionOutlineRegistry.get('s1')
    expect(controller).toBeDefined()

    let fires = 0
    const sub = controller!.onDidChangeActive(() => {
      fires += 1
    })

    // Alt+Down / Alt+Up equivalent: moving the session selection must surface to
    // the outline both as an event AND as an updated getActiveKey().
    act(() => {
      widgetRef.current!.moveTimeline('first')
    })
    expect(controller!.getActiveKey()).toBe('m:a')
    expect(fires).toBeGreaterThan(0)

    const before = fires
    act(() => {
      widgetRef.current!.moveTimeline('next')
    })
    expect(controller!.getActiveKey()).toBe('m:b')
    expect(fires).toBeGreaterThan(before)

    sub.dispose()
  })

  it('reports the clicked slot as the active key', () => {
    const { container } = renderChat(makeSession('s1', items))
    const controller = AcpSessionOutlineRegistry.get('s1')!
    act(() => {
      fireEvent.click(slotEl(container, 'm:c'))
    })
    expect(controller.getActiveKey()).toBe('m:c')
  })

  // Repro for the reported bug: with the AGENTS side panel AND the full-screen
  // session editor both mounted for the SAME active session, two ChatBody
  // instances register a controller under the same id. The outline reads
  // registry.get() (the last registered) — moving the selection in the OTHER
  // instance must still surface, or the outline highlight goes stale.
  it('keeps the active key in sync when two ChatBody instances share a session', () => {
    const session = makeSession('s1', items)
    const panel = renderChatWithWidget(session)
    const editor = renderChatWithWidget(session)

    const controller = AcpSessionOutlineRegistry.get('s1')!
    act(() => {
      panel.widgetRef.current!.moveTimeline('last')
    })
    expect(controller.getActiveKey()).toBe('m:c')

    act(() => {
      editor.widgetRef.current!.moveTimeline('first')
    })
    expect(controller.getActiveKey()).toBe('m:a')
  })

  // Repro for "works in a production build (e2e) but the outline highlight never
  // moves under `pnpm dev`". The only behavioural difference is React StrictMode
  // (main.tsx wraps the app in it; dev double-invokes effects mount→cleanup→mount
  // to surface unsafe effects, a no-op in production). If the active-slot emitter
  // is created with `useRef(new Emitter())` and disposed in an effect cleanup, the
  // StrictMode dry-run disposes it and the re-mount keeps firing on the dead
  // emitter — so onDidChangeActive never notifies and the outline stays stale.
  it('still fires onDidChangeActive under StrictMode (dev double-invoke)', () => {
    const widgetRef: { current?: AcpChatWidget } = {}
    const inst = makeInstantiation((w) => {
      widgetRef.current = w
    })
    render(
      <StrictMode>
        <ServicesContext.Provider value={inst}>
          <ChatBody session={makeSession('s1', items)} />
        </ServicesContext.Provider>
      </StrictMode>,
    )

    const controller = AcpSessionOutlineRegistry.get('s1')
    expect(controller).toBeDefined()

    let fires = 0
    const sub = controller!.onDidChangeActive(() => {
      fires += 1
    })
    act(() => {
      widgetRef.current!.moveTimeline('first')
    })
    expect(controller!.getActiveKey()).toBe('m:a')
    expect(fires).toBeGreaterThan(0)
    sub.dispose()
  })

  // Regression for "an outline click lands off and needs a second click": the
  // clicked row's real DOM rect is the authoritative target, so scrollToKey must
  // align scrollTop to it on the first call (the shared convergence loop's
  // synchronous first frame), not leave it at the estimate-derived position.
  // The landing is offset up by the target's header height plus a small gap so
  // sticky scroll does not pin the card onto itself and hide it (and its
  // bookmark badge) behind the sticky-header overlay.
  it('scrolls the clicked slot just below the sticky header on the first scrollToKey call', () => {
    const { container } = renderChat(makeSession('s1', items))
    const scroll = scrollEl(container)
    Object.defineProperty(scroll, 'scrollHeight', { value: 5000, configurable: true })
    Object.defineProperty(scroll, 'clientHeight', { value: 300, configurable: true })
    scroll.scrollTop = 0
    // Container top at 0; the target row sits 500px below the viewport top.
    ;(scroll as HTMLElement).getBoundingClientRect = (() => ({ top: 0 }) as DOMRect) as never
    const target = container.querySelector<HTMLElement>('[data-sticky-key="m:c"]')!
    ;(target as HTMLElement).getBoundingClientRect = (() => ({ top: 500 }) as DOMRect) as never
    // Give the card header a measurable height so the reveal offset is exercised.
    const header = target.querySelector<HTMLElement>(
      'button[data-testid="acp-collapsible-toggle"]',
    )!
    ;(header as HTMLElement).getBoundingClientRect = (() => ({ height: 24 }) as DOMRect) as never

    const controller = AcpSessionOutlineRegistry.get('s1')!
    act(() => {
      controller.scrollToKey('m:c')
    })

    // scrollTop + (rowTop - containerTop) - (headerHeight + gap) = 0 + 500 - (24 + 8)
    // → the row's top lands just under the sticky header, accurate without a second click.
    expect(scroll.scrollTop).toBe(468)
    expect(controller.getActiveKey()).toBe('m:c')
  })
})

describe('ChatBody — compaction slot', () => {
  it('renders a running compaction card with status text', () => {
    const items: readonly TimelineItem[] = [
      { kind: 'message', id: 'a', message: makeMessage('a', 'hi') },
      { kind: 'compaction', id: 'compaction:c1', compaction: { phase: 'running' } },
    ]
    const { container } = renderChat(makeSession('s-cmp', items))
    const card = container.querySelector<HTMLElement>('[data-testid="acp-compaction-card"]')
    expect(card).not.toBeNull()
    expect(card?.dataset['phase']).toBe('running')
    expect(card?.textContent).toContain('Compacting context')
  })

  it('renders the failure reason on a failed compaction', () => {
    const items: readonly TimelineItem[] = [
      { kind: 'compaction', id: 'compaction:c2', compaction: { phase: 'failed', reason: 'boom' } },
    ]
    const { container } = renderChat(makeSession('s-cmp2', items))
    const card = container.querySelector<HTMLElement>('[data-testid="acp-compaction-card"]')
    expect(card?.dataset['phase']).toBe('failed')
    expect(card?.textContent).toContain('boom')
  })

  it('shows a live stopwatch with estimated percent while running and freezes the total on settle', () => {
    const running: readonly TimelineItem[] = [
      {
        kind: 'compaction',
        id: 'compaction:c3',
        compaction: { phase: 'running', startedAt: Date.now() - 5_000 },
      },
    ]
    const { container } = renderChat(makeSession('s-cmp3', running))
    const timer = container.querySelector<HTMLElement>('[data-testid="acp-compaction-timer"]')
    // ~5s in with tau=6s → ~57%; assert the shape rather than the exact value.
    expect(timer?.textContent).toMatch(/^\d{1,2}% · 5s$/)
    const bar = container.querySelector<HTMLElement>('[role="progressbar"]')
    expect(bar).not.toBeNull()
    const now = Number(bar?.getAttribute('aria-valuenow'))
    expect(now).toBeGreaterThan(0)
    expect(now).toBeLessThan(100)

    const settled: readonly TimelineItem[] = [
      {
        kind: 'compaction',
        id: 'compaction:c4',
        compaction: { phase: 'success', durationMs: 72_000 },
      },
    ]
    const { container: c2 } = renderChat(makeSession('s-cmp4', settled))
    const settledTimer = c2.querySelector<HTMLElement>('[data-testid="acp-compaction-timer"]')
    expect(settledTimer?.textContent).toBe('1:12')
    expect(c2.querySelector('[role="progressbar"]')).toBeNull()
  })
})

describe('ChatBody — side task affordances', () => {
  const items: readonly TimelineItem[] = [
    { kind: 'message', id: 'a', message: makeMessage('a', 'first') },
  ]

  function makeSideTaskRow(
    sessionIdOnAgent: string,
    sideTaskOf: string,
    lastUsedAt: number,
  ): AcpSessionHistoryEntry {
    return {
      id: sessionIdOnAgent,
      agentId: 'fake',
      sessionIdOnAgent,
      title: `side ${sessionIdOnAgent}`,
      createdAt: lastUsedAt,
      lastUsedAt,
      sideTaskOf,
      sideTaskQuote: `quote ${sessionIdOnAgent}`,
    }
  }

  function makeHistory(entries: AcpSessionHistoryEntry[]): Partial<IAcpSessionHistoryServiceType> {
    return {
      entries: observableValue<readonly AcpSessionHistoryEntry[]>('t.sessionHistory', entries),
      get: (id: string) => entries.find((e) => e.sessionIdOnAgent === id),
    }
  }

  describe('context menu fork gating', () => {
    it('reports fork support when the agent supports fork and the chat is writable', () => {
      const setForkSupported = vi.fn()
      const inst = makeInstantiation(undefined, undefined, {
        widget: { setForkSupported },
      })
      const { container } = render(
        <ServicesContext.Provider value={inst}>
          <ChatBody session={makeSession('s1', items, { forkSupported: true })} />
        </ServicesContext.Provider>,
      )

      fireEvent.contextMenu(slotEl(container, 'm:a'))
      expect(setForkSupported).toHaveBeenCalledWith(true)
    })

    it('reports no fork support in read-only (foreign) previews even when the agent forks', () => {
      const setForkSupported = vi.fn()
      const inst = makeInstantiation(undefined, undefined, {
        widget: { setForkSupported },
      })
      const { container } = render(
        <ServicesContext.Provider value={inst}>
          <ChatBody session={makeSession('s1', items, { forkSupported: true })} readOnly />
        </ServicesContext.Provider>,
      )

      fireEvent.contextMenu(slotEl(container, 'm:a'))
      expect(setForkSupported).toHaveBeenCalledWith(false)
    })
  })

  describe('SideTasksBar', () => {
    it('is hidden for a session without side tasks', () => {
      const inst = makeInstantiation(undefined, undefined, { history: makeHistory([]) })
      const { container } = render(
        <ServicesContext.Provider value={inst}>
          <ChatBody session={makeSession('s1', items)} />
        </ServicesContext.Provider>,
      )
      expect(container.querySelector('[data-testid="acp-side-tasks-trigger"]')).toBeNull()
    })

    it('is hidden on a side-task chat itself (its quote chip renders instead)', () => {
      const rows = [
        makeSideTaskRow('side-1', 's1', 1000),
        makeSideTaskRow('side-2', 's1', 2000),
        makeSideTaskRow('grand-1', 'side-1', 3000),
      ]
      const inst = makeInstantiation(undefined, undefined, { history: makeHistory(rows) })
      const { container } = render(
        <ServicesContext.Provider value={inst}>
          <ChatBody session={makeSession('side-1', items)} />
        </ServicesContext.Provider>,
      )
      expect(container.querySelector('[data-testid="acp-side-tasks-trigger"]')).toBeNull()
      const chip = container.querySelector('[data-testid="acp-side-task-quote"]')
      expect(chip).not.toBeNull()
      expect(chip?.getAttribute('data-tooltip')).toBe('quote side-1')
    })

    it('opens the picked side task in a right-split editor tab', () => {
      const rows = [makeSideTaskRow('side-1', 's1', 1000), makeSideTaskRow('side-2', 's1', 2000)]
      const groups = new EditorGroupsService()
      const inst = makeInstantiation(undefined, undefined, {
        history: makeHistory(rows),
        groups,
      })
      const { container } = render(
        <ServicesContext.Provider value={inst}>
          <ChatBody session={makeSession('s1', items)} />
        </ServicesContext.Provider>,
      )

      const trigger = container.querySelector<HTMLElement>(
        '[data-testid="acp-side-tasks-trigger"]',
      )!
      expect(trigger.textContent).toContain('(2)')

      fireEvent.click(trigger)
      const popover = container.querySelector('[data-testid="acp-side-tasks-popover"]')
      expect(popover).not.toBeNull()

      // Rows sort by lastUsedAt desc → side-2 first.
      const rowEls = [...container.querySelectorAll('[data-testid="acp-side-task-row"]')]
      expect(rowEls[0]?.textContent).toContain('side side-2')

      fireEvent.click(rowEls[0]!)

      // Popover closes, a right-split group is created and the tab for the
      // picked side task becomes its active editor.
      expect(container.querySelector('[data-testid="acp-side-tasks-popover"]')).toBeNull()
      expect(groups.groups.length).toBe(2)
      const active = groups.activeGroup.activeEditor
      expect(active).toBeInstanceOf(AcpSessionEditorInput)
      expect((active as AcpSessionEditorInput).sessionId).toBe('side-2')
    })
  })

  describe('side-task visual distinction', () => {
    it('marks the chat container of a side-task session with data-side-task', () => {
      const rows = [makeSideTaskRow('side-1', 's1', 1000)]
      const inst = makeInstantiation(undefined, undefined, { history: makeHistory(rows) })
      const { container } = render(
        <ServicesContext.Provider value={inst}>
          <ChatBody session={makeSession('side-1', items)} />
        </ServicesContext.Provider>,
      )
      expect(
        container.querySelector('[data-testid="acp-chat"]')?.getAttribute('data-side-task'),
      ).toBe('true')
    })

    it('leaves a regular session chat unmarked', () => {
      const rows = [makeSideTaskRow('side-1', 's1', 1000)]
      const inst = makeInstantiation(undefined, undefined, { history: makeHistory(rows) })
      const { container } = render(
        <ServicesContext.Provider value={inst}>
          <ChatBody session={makeSession('s1', items)} />
        </ServicesContext.Provider>,
      )
      expect(
        container.querySelector('[data-testid="acp-chat"]')?.getAttribute('data-side-task'),
      ).toBeNull()
    })

    it('renders no empty-session hint for a blank side-task chat', () => {
      const rows = [makeSideTaskRow('side-1', 's1', 1000)]
      const inst = makeInstantiation(undefined, undefined, { history: makeHistory(rows) })
      const { container } = render(
        <ServicesContext.Provider value={inst}>
          <ChatBody session={makeSession('side-1', [])} />
        </ServicesContext.Provider>,
      )
      expect(container.querySelector('[data-testid="acp-empty-session-hint"]')).toBeNull()
      // The quote chip stays — it is the only top marker a fresh side task shows.
      expect(container.querySelector('[data-testid="acp-side-task-quote"]')).not.toBeNull()
    })

    it('keeps the empty-session hint for a blank regular chat', () => {
      const rows = [makeSideTaskRow('side-1', 's1', 1000)]
      const inst = makeInstantiation(undefined, undefined, { history: makeHistory(rows) })
      const { container } = render(
        <ServicesContext.Provider value={inst}>
          <ChatBody session={makeSession('s1', [])} />
        </ServicesContext.Provider>,
      )
      expect(container.querySelector('[data-testid="acp-empty-session-hint"]')).not.toBeNull()
    })
  })
})

describe('ChatBody — sub-agent keyboard navigation', () => {
  const userItem = (id: string, text: string): TimelineItem => ({
    kind: 'message',
    id,
    message: { id, role: 'user', text, blocks: [{ type: 'text', text }], streaming: false },
  })
  const makeTaskCall = (id: string, children: AcpToolCall['children']): AcpToolCall => ({
    id,
    title: 'Task',
    // 'other' defaults to collapsed under the default mode — the tests drive the
    // chevron to expand, exercising the same fold state the renderer consults.
    kind: 'other',
    status: 'completed',
    text: '',
    blocks: [],
    diffs: [],
    ...(children !== undefined ? { children } : {}),
  })
  const childMessage = (id: string, text: string) =>
    ({ kind: 'message', id, message: makeMessage(id, text) }) as const
  const childToolCall = (id: string, title: string) =>
    ({
      kind: 'toolCall',
      id,
      call: { id, title, kind: 'read', status: 'completed', text: '', blocks: [], diffs: [] },
    }) as const

  const navItems = (children: NonNullable<AcpToolCall['children']>): readonly TimelineItem[] => [
    userItem('u', 'top question'),
    { kind: 'toolCall', id: 'task', call: makeTaskCall('task', children) },
    { kind: 'message', id: 'a', message: makeMessage('a', 'after task') },
  ]

  const stickyEl = (container: HTMLElement, key: string): HTMLElement => {
    const el = container.querySelector<HTMLElement>(`[data-sticky-key="${key}"]`)
    if (!el) throw new Error(`no element for sticky key ${key}`)
    return el
  }
  const toggleCard = (container: HTMLElement, key: string): void => {
    act(() => {
      fireEvent.click(
        slotEl(container, key).querySelector('[data-testid="acp-collapsible-toggle"]')!,
      )
    })
  }

  it('Alt+J/K stays on the current level — children are skipped until Alt+L descends', () => {
    const { container, widgetRef } = renderChatWithWidget(
      makeSession(
        's-sub-nav',
        navItems([childMessage('sm1', 'sub one'), childMessage('sm2', 'sub two')]),
      ),
    )
    toggleCard(container, 't:task')
    expect(container.querySelector('[data-testid="acp-subagent-timeline"]')).not.toBeNull()

    act(() => {
      fireEvent.click(slotEl(container, 't:task'))
    })
    expect(slotEl(container, 't:task').className).toContain(focusedClass)

    // Alt+J skips the expanded children entirely — the next top-level item wins.
    act(() => {
      widgetRef.current!.moveTimeline('next')
    })
    expect(slotEl(container, 'm:a').className).toContain(focusedClass)
    act(() => {
      widgetRef.current!.moveTimeline('prev')
    })
    expect(slotEl(container, 't:task').className).toContain(focusedClass)

    // Alt+L descends into the sub-agent timeline…
    act(() => {
      widgetRef.current!.moveTimelineLevel('in')
    })
    expect(stickyEl(container, 't:task/m:sm1').className).toContain(focusedClass)
    expect(slotEl(container, 't:task').className).not.toContain(focusedClass)

    // …and Alt+J/K now walk the sibling children, clamping at the ends.
    act(() => {
      widgetRef.current!.moveTimeline('next')
    })
    expect(stickyEl(container, 't:task/m:sm2').className).toContain(focusedClass)
    act(() => {
      widgetRef.current!.moveTimeline('next')
    })
    expect(stickyEl(container, 't:task/m:sm2').className).toContain(focusedClass)
    act(() => {
      widgetRef.current!.moveTimeline('prev')
    })
    expect(stickyEl(container, 't:task/m:sm1').className).toContain(focusedClass)
    // Clamp at the top end of the sibling sequence — staying, not escaping.
    act(() => {
      widgetRef.current!.moveTimeline('prev')
    })
    expect(stickyEl(container, 't:task/m:sm1').className).toContain(focusedClass)

    // Alt+L on a leaf child is a no-op; Alt+H ascends back to the parent card.
    act(() => {
      widgetRef.current!.moveTimelineLevel('in')
    })
    expect(stickyEl(container, 't:task/m:sm1').className).toContain(focusedClass)
    act(() => {
      widgetRef.current!.moveTimelineLevel('out')
    })
    expect(slotEl(container, 't:task').className).toContain(focusedClass)
    // Alt+H at the top level is a no-op too.
    act(() => {
      widgetRef.current!.moveTimelineLevel('out')
    })
    expect(slotEl(container, 't:task').className).toContain(focusedClass)
  })

  it('Alt+L on a folded card expands it in place; a second Alt+L steps in', () => {
    const { container, widgetRef } = renderChatWithWidget(
      makeSession('s-sub-expand', navItems([childMessage('sm1', 'sub one')])),
    )
    // kind 'other' starts collapsed under the default mode.
    expect(container.querySelector('[data-testid="acp-subagent-timeline"]')).toBeNull()

    act(() => {
      fireEvent.click(slotEl(container, 't:task'))
    })
    expect(slotEl(container, 't:task').className).toContain(focusedClass)

    act(() => {
      widgetRef.current!.moveTimelineLevel('in')
    })
    // Expanded in place — focus stays on the parent card.
    expect(container.querySelector('[data-testid="acp-subagent-timeline"]')).not.toBeNull()
    expect(slotEl(container, 't:task').className).toContain(focusedClass)

    act(() => {
      widgetRef.current!.moveTimelineLevel('in')
    })
    expect(stickyEl(container, 't:task/m:sm1').className).toContain(focusedClass)
  })

  it('skips the children of a collapsed task card', () => {
    const { container, widgetRef } = renderChatWithWidget(
      makeSession('s-sub-collapsed', navItems([childMessage('sm1', 'sub one')])),
    )
    // kind 'other' starts collapsed under the default mode — no sub timeline mounted.
    expect(container.querySelector('[data-testid="acp-subagent-timeline"]')).toBeNull()

    act(() => {
      fireEvent.click(slotEl(container, 't:task'))
    })
    act(() => {
      widgetRef.current!.moveTimeline('next')
    })
    expect(slotEl(container, 'm:a').className).toContain(focusedClass)
    act(() => {
      widgetRef.current!.moveTimeline('prev')
    })
    expect(slotEl(container, 't:task').className).toContain(focusedClass)
  })

  it('Alt+E/Alt+A operate within the current level', () => {
    const items: readonly TimelineItem[] = [
      userItem('u', 'top question'),
      { kind: 'message', id: 'a', message: makeMessage('a', 'answer one') },
      {
        kind: 'toolCall',
        id: 'task',
        call: makeTaskCall('task', [
          childMessage('sm1', 'sub one'),
          childMessage('sm2', 'sub two'),
        ]),
      },
    ]
    const { container, widgetRef } = renderChatWithWidget(makeSession('s-sub-last', items))
    toggleCard(container, 't:task')

    // Top-level last is the trailing task card itself — its children are no
    // longer spliced into the sequence.
    act(() => {
      widgetRef.current!.moveTimeline('last')
    })
    expect(slotEl(container, 't:task').className).toContain(focusedClass)

    // Descend, then first/last walk the sibling children instead.
    act(() => {
      widgetRef.current!.moveTimelineLevel('in')
    })
    expect(stickyEl(container, 't:task/m:sm1').className).toContain(focusedClass)
    act(() => {
      widgetRef.current!.moveTimeline('last')
    })
    expect(stickyEl(container, 't:task/m:sm2').className).toContain(focusedClass)
    act(() => {
      widgetRef.current!.moveTimeline('first')
    })
    expect(stickyEl(container, 't:task/m:sm1').className).toContain(focusedClass)
  })

  it('copies the focused sub-agent message text', () => {
    const { container, widgetRef } = renderChatWithWidget(
      makeSession(
        's-sub-copy',
        navItems([childMessage('sm1', 'sub one'), childToolCall('sc1', 'Read')]),
      ),
    )
    toggleCard(container, 't:task')
    act(() => {
      fireEvent.click(slotEl(container, 't:task'))
    })
    act(() => {
      widgetRef.current!.moveTimelineLevel('in')
    })
    expect(widgetRef.current!.getFocusedText()).toBe('sub one')
  })

  it('marks a clicked sub-agent message as focused', () => {
    const { container } = renderChat(
      makeSession('s-sub-click', navItems([childMessage('sm1', 'sub one')])),
    )
    toggleCard(container, 't:task')
    const child = stickyEl(container, 't:task/m:sm1')
    expect(child.className).not.toContain(focusedClass)
    act(() => {
      fireEvent.click(child)
    })
    expect(stickyEl(container, 't:task/m:sm1').className).toContain(focusedClass)
    expect(slotEl(container, 't:task').className).not.toContain(focusedClass)
  })

  it('pulls focus back to the parent key when the focused child folds away', () => {
    const { container, widgetRef } = renderChatWithWidget(
      makeSession('s-sub-fold', navItems([childMessage('sm1', 'sub one')])),
    )
    toggleCard(container, 't:task')
    act(() => {
      fireEvent.click(stickyEl(container, 't:task/m:sm1'))
    })
    expect(stickyEl(container, 't:task/m:sm1').className).toContain(focusedClass)

    // Chevron fold: the child unmounts, focus converges to the parent card.
    toggleCard(container, 't:task')
    expect(container.querySelector('[data-testid="acp-subagent-timeline"]')).toBeNull()
    expect(slotEl(container, 't:task').className).toContain(focusedClass)

    // Re-expand, focus the child again, then fold everything via Ctrl+Alt+F.
    toggleCard(container, 't:task')
    act(() => {
      fireEvent.click(stickyEl(container, 't:task/m:sm1'))
    })
    act(() => {
      widgetRef.current!.cycleCollapseMode() // collapsed
    })
    expect(slotEl(container, 't:task').className).toContain(focusedClass)
  })

  it('persists a composite focusedKey and restores it while the parent stays expanded', () => {
    const items = navItems([childMessage('sm1', 'sub one')])
    const first = renderChatWithWidget(makeSession('s-sub-restore', items))
    toggleCard(first.container, 't:task')
    act(() => {
      fireEvent.click(stickyEl(first.container, 't:task/m:sm1'))
    })
    first.unmount()

    expect(AcpChatViewStateCache.load('s-sub-restore')?.focusedKey).toBe('t:task/m:sm1')

    const second = renderChat(makeSession('s-sub-restore', items))
    expect(stickyEl(second.container, 't:task/m:sm1').className).toContain(focusedClass)
  })

  it('falls back to the parent key on restore when the parent is collapsed', () => {
    const items = navItems([childMessage('sm1', 'sub one')])
    AcpChatViewStateCache.save('s-sub-restore-folded', {
      scrollTop: 0,
      stuck: true,
      focusedKey: 't:task/m:sm1',
      // No overrides: kind 'other' resolves collapsed under the default mode.
      collapse: { mode: 'default', overrides: [] },
    })
    const { container } = renderChat(makeSession('s-sub-restore-folded', items))
    expect(container.querySelector('[data-testid="acp-subagent-timeline"]')).toBeNull()
    expect(slotEl(container, 't:task').className).toContain(focusedClass)
  })
})
