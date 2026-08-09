/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for StickyUserMessageBar — derives the first user message from the
 *  timeline, starts collapsed, expands on click, and pins the opening message.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  ICommandService,
  IContextKeyService,
  IOpenerService,
  InstantiationService,
  ServiceCollection,
  URI,
  observableValue,
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

function makeSession(id: string, items: TimelineItem[]): IAcpSession {
  return {
    id,
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
  } as unknown as IAcpChatWidgetService)
  services.set(IOpenerService, { open } as unknown as IOpenerService)
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
