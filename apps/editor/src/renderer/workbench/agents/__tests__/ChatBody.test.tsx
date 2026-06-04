/*---------------------------------------------------------------------------------------------
 *  Tests for ChatBody / ChatScroll — mouse click selects a timeline item (so
 *  Alt+J/K navigate relative to it) and the focused item survives an unmount →
 *  remount cycle via AcpChatViewStateCache (editor-tab / session switch).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, cleanup, act, fireEvent } from '@testing-library/react'
import {
  Event,
  IConfigurationService,
  ICommandService,
  IFileSearchService,
  IFileService,
  InstantiationService,
  IWorkspaceService,
  observableValue,
  ServiceCollection,
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
import {
  IAcpChatWidgetService,
  type AcpChatWidget,
} from '../../../services/acp/acpChatWidgetService.js'
import { AcpChatViewStateCache } from '../../../services/acp/acpChatViewStateCache.js'
import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import { ChatBody } from '../ChatBody.js'
import { ServicesContext } from '../../useService.js'
import styles from '../agents.module.css'

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
})

const focusedClass = styles['timelineSlotFocused'] as string
const emptySessionClass = styles['chatEmptySession'] as string

function makeMessage(id: string, text: string): AcpMessage {
  return { id, role: 'agent', text, blocks: [{ type: 'text', text }], streaming: false }
}

function makeSession(id: string, items: readonly TimelineItem[]): IAcpSession {
  const collapseMode = observableValue<'default' | 'collapsed' | 'expanded'>(
    't.collapse',
    'default',
  )
  return {
    id,
    agentId: 'fake',
    title: 'Fake',
    messages: observableValue<readonly AcpMessage[]>('t.messages', []),
    toolCalls: observableValue<readonly AcpToolCall[]>('t.toolCalls', []),
    plan: observableValue<readonly AcpPlanEntry[]>('t.plan', []),
    timeline: observableValue<readonly TimelineItem[]>('t.timeline', items),
    status: observableValue<AcpSessionStatus>('t.status', 'idle'),
    usage: observableValue<AcpUsage | undefined>('t.usage', undefined),
    pendingPermission: observableValue<AcpPendingPermission | undefined>('t.perm', undefined),
    pendingQuestion: observableValue('t.question', undefined),
    configOptions: observableValue<readonly SessionConfigOption[]>('t.cfg', []),
    availableCommands: observableValue('t.cmds', []),
    mcpServers: observableValue('t.mcp', []),
    collapseMode,
    cycleCollapseMode: () => {
      const cur = collapseMode.get()
      const next = cur === 'default' ? 'collapsed' : cur === 'collapsed' ? 'expanded' : 'default'
      collapseMode.set(next, undefined)
    },
    presentPermission: () => {},
    presentQuestion: () => {},
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

function makeInstantiation(
  onRegister?: (w: AcpChatWidget) => void,
  onCommand?: (id: string) => void,
) {
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
    register: (w: AcpChatWidget) => {
      onRegister?.(w)
      return { dispose() {} }
    },
  } as unknown as IAcpChatWidgetService)
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
    executeCommand: (id: string) => {
      onCommand?.(id)
      return Promise.resolve(undefined)
    },
  } as unknown as ICommandService)
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

  it('agent messages start expanded; thought messages start collapsed', () => {
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
    expect(ariaExpanded(container, 'm:c')).toBe('false')
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
