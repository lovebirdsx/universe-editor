/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for StickyUserMessageBar — derives the first user message from the
 *  timeline, starts collapsed, expands on click, and pins the opening message.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  Action2,
  ContextKeyService,
  Event,
  ICommandService,
  IContextKeyService,
  IOpenerService,
  InstantiationService,
  IUriIdentityService,
  IWorkspaceService,
  localize2,
  MenuId,
  ServiceCollection,
  URI,
  observableValue,
  registerAction2,
  type IUriIdentityService as IUriIdentityServiceType,
  type IWorkspaceService as IWorkspaceServiceType,
  type ServicesAccessor,
} from '@universe-editor/platform'
import type {
  IAcpSession,
  SelectionContext,
  TimelineItem,
} from '../../../services/acp/session/acpSessionService.js'
import { IAcpChatWidgetService } from '../../../services/acp/session/acpChatWidgetService.js'
import { StickyUserMessageBar } from '../StickyUserMessageBar.js'
import { ServicesContext } from '../../useService.js'

afterEach(() => {
  cleanup()
})

const stubWorkspace: IWorkspaceServiceType = {
  _serviceBrand: undefined,
  current: { folder: URI.file('X:/workspace'), name: 'workspace' },
  onDidChangeWorkspace: Event.None,
  recent: [],
  onDidChangeRecent: Event.None,
} as unknown as IWorkspaceServiceType

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

function message(
  id: string,
  role: 'user' | 'agent',
  text: string,
  selectionContexts?: readonly SelectionContext[],
): TimelineItem {
  return {
    kind: 'message',
    id,
    message: {
      id,
      role,
      text,
      blocks: [{ type: 'text', text }],
      streaming: false,
      ...(selectionContexts !== undefined ? { selectionContexts } : {}),
    },
  }
}

function makeSession(id: string, items: TimelineItem[], cwd?: string): IAcpSession {
  return {
    id,
    readOnly: false,
    cwd,
    forkSupported: observableValue<boolean>(`fork:${id}`, false),
    timeline: observableValue<readonly TimelineItem[]>(`tl:${id}`, items),
  } as unknown as IAcpSession
}

function renderWithServices(node: React.ReactNode) {
  const open = vi.fn().mockResolvedValue(true)
  const services = new ServiceCollection()
  services.set(ICommandService, {
    executeCommand: () => Promise.resolve(),
  } as unknown as ICommandService)
  services.set(IContextKeyService, {
    createKey: () => ({ set: () => {} }),
  } as unknown as IContextKeyService)
  services.set(IAcpChatWidgetService, {
    setHasSelection: () => {},
    setForkSupported: () => {},
    setContextTarget: () => {},
  } as unknown as IAcpChatWidgetService)
  services.set(IOpenerService, { open } as unknown as IOpenerService)
  services.set(IWorkspaceService, stubWorkspace)
  services.set(IUriIdentityService, stubUriIdentity)
  const inst = new InstantiationService(services)
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <ServicesContext.Provider value={inst}>{children}</ServicesContext.Provider>
  )
  return { ...render(node, { wrapper: Wrapper }), open }
}

describe('StickyUserMessageBar', () => {
  it('renders nothing when there is no user message', () => {
    renderWithServices(<StickyUserMessageBar session={makeSession('s-empty', [])} />)
    expect(screen.queryByTestId('acp-user-bar')).toBeNull()
  })

  it('starts collapsed showing the summary, then expands to the full content', () => {
    renderWithServices(
      <StickyUserMessageBar
        session={makeSession('s-one', [message('u1', 'user', 'Hello world')])}
      />,
    )
    expect(screen.getByText('Hello world')).toBeTruthy()
    expect(screen.getByTestId('acp-user-bar')).toBeTruthy()
    const md = screen.getByTestId('acp-markdown')
    expect(md.textContent).toContain('Hello world')
    fireEvent.click(screen.getByTestId('acp-collapsible-toggle'))
    // Collapsed: summary text shows, full markdown body is not mounted.
    expect(screen.queryByTestId('acp-markdown')).toBeNull()
  })

  it('shows the first user message when several exist', () => {
    renderWithServices(
      <StickyUserMessageBar
        session={makeSession('s-many', [
          message('u1', 'user', 'first request'),
          message('a1', 'agent', 'some reply'),
          message('u2', 'user', 'second request'),
        ])}
      />,
    )
    expect(screen.getByText('first request')).toBeTruthy()
    expect(screen.queryByText('second request')).toBeNull()
  })

  // The bar scrolls internally (max-height) — the header must carry the sticky
  // class so the collapse chevron stays reachable while scrolled.
  it('marks the header sticky inside the scrolling bar', () => {
    renderWithServices(
      <StickyUserMessageBar session={makeSession('s-sticky', [message('u1', 'user', 'long')])} />,
    )
    expect(screen.getByTestId('acp-collapsible-toggle').className).toContain('stickyUserBarHeader')
  })

  // The cwd pill lives inside the bar's header row (no extra vertical space):
  // right after the role icon.
  it('shows the cwd pill inside the header when the cwd is a strict subdirectory', () => {
    renderWithServices(
      <StickyUserMessageBar
        session={makeSession('s-cwd', [message('u1', 'user', 'hello')], 'X:/workspace/apps')}
      />,
    )
    const pill = screen.getByTestId('acp-session-cwd')
    expect(pill.textContent).toBe('apps')
    const header = screen.getByTestId('acp-collapsible-toggle')
    expect(header.contains(pill)).toBe(true)
    // Pill follows the role icon: it sits in the headerSuffix slot, whose
    // previous sibling is the icon span.
    const suffixSlot = pill.parentElement
    expect(suffixSlot?.className).toContain('slotHeaderSuffix')
    const iconSlot = suffixSlot?.previousElementSibling
    expect(iconSlot?.className).toContain('slotIcon')
    expect(pill.compareDocumentPosition(iconSlot!) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
  })

  it('shows no cwd pill for a root-level cwd', () => {
    renderWithServices(
      <StickyUserMessageBar
        session={makeSession('s-root', [message('u1', 'user', 'hello')], 'X:/workspace')}
      />,
    )
    expect(screen.queryByTestId('acp-session-cwd')).toBeNull()
  })

  it('shows and reveals selection attachments for the pinned first message', () => {
    const selection: SelectionContext = {
      uri: 'file:///workspace/src/a.ts',
      relPath: 'src/a.ts',
      text: 'const value = 1',
      startLine: 12,
      endLine: 12,
      languageId: 'typescript',
    }
    const { open } = renderWithServices(
      <StickyUserMessageBar
        session={makeSession('s-selection', [message('u1', 'user', 'Explain', [selection])])}
      />,
    )

    fireEvent.click(screen.getByTestId('acp-selection-context-chip'))
    expect(screen.getByText('src/a.ts:12')).toBeTruthy()
    expect(open).toHaveBeenCalledWith(URI.parse('file:///workspace/src/a.ts#12,1-12,1'), {
      fromUserGesture: true,
    })
  })
})

class CaptureStickyContextArgAction extends Action2 {
  static readonly ID = 'test.acpStickyChatContext.captureArg'
  constructor() {
    super({
      id: CaptureStickyContextArgAction.ID,
      title: localize2('test.acpStickyChatContext.captureArg', 'Capture Session Arg'),
      menu: [{ id: MenuId.AcpChatContext, group: 'z_test', order: 1 }],
    })
  }

  override run(_accessor: ServicesAccessor): void {}
}

// Mirrors ChatBody's "context menu fragment targets" suite: the pinned first
// user message lives outside the chat scroll container, so it needs the same
// copy-target wiring on its own context-menu handler.
describe('StickyUserMessageBar — context menu fragment targets', () => {
  it('resolves an image block in the pinned first message as an image target', () => {
    const disposable = registerAction2(CaptureStickyContextArgAction)
    try {
      const src = 'data:image/png;base64,QUJD'
      const session = makeSession('s-sticky-menu', [
        {
          kind: 'message',
          id: 'u1',
          message: {
            id: 'u1',
            role: 'user',
            text: '',
            blocks: [{ type: 'image', data: 'QUJD', mimeType: 'image/png' }],
            streaming: false,
          },
        },
      ])
      const command = vi.fn()
      const setContextTarget = vi.fn()
      const services = new ServiceCollection()
      services.set(IContextKeyService, new ContextKeyService())
      services.set(ICommandService, {
        executeCommand: (id: string, ...args: unknown[]) => {
          command(id, ...args)
          return Promise.resolve(undefined)
        },
      } as unknown as ICommandService)
      services.set(IAcpChatWidgetService, {
        setHasSelection: () => {},
        setForkSupported: () => {},
        setContextTarget,
      } as unknown as IAcpChatWidgetService)
      services.set(IOpenerService, { open: vi.fn() } as unknown as IOpenerService)
      const inst = new InstantiationService(services)
      const { container, getByText } = render(
        <ServicesContext.Provider value={inst}>
          <StickyUserMessageBar session={session} />
        </ServicesContext.Provider>,
      )

      fireEvent.contextMenu(container.querySelector('[data-testid="acp-image-block"]')!)
      fireEvent.click(getByText('Capture Session Arg'))

      expect(setContextTarget).toHaveBeenCalledWith('image')
      // The menu's onClose runs before the command executes and resets the keys.
      expect(setContextTarget).toHaveBeenLastCalledWith(undefined)
      expect(command).toHaveBeenCalledWith(CaptureStickyContextArgAction.ID, {
        sessionId: 's-sticky-menu',
        target: { kind: 'image', src },
      })
    } finally {
      disposable.dispose()
    }
  })
})
