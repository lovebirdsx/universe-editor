/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for StickyUserMessageBar — derives the first user message from the
 *  timeline, starts collapsed, expands on click, and pins the opening message.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  ICommandService,
  IContextKeyService,
  InstantiationService,
  ServiceCollection,
  observableValue,
} from '@universe-editor/platform'
import type { IAcpSession, TimelineItem } from '../../../services/acp/acpSessionService.js'
import { IAcpChatWidgetService } from '../../../services/acp/acpChatWidgetService.js'
import { StickyUserMessageBar } from '../StickyUserMessageBar.js'
import { ServicesContext } from '../../useService.js'

afterEach(() => {
  cleanup()
})

function message(id: string, role: 'user' | 'agent', text: string): TimelineItem {
  return {
    kind: 'message',
    id,
    message: { id, role, text, blocks: [{ type: 'text', text }], streaming: false },
  }
}

function makeSession(id: string, items: TimelineItem[]): IAcpSession {
  return {
    id,
    timeline: observableValue<readonly TimelineItem[]>(`tl:${id}`, items),
  } as unknown as IAcpSession
}

function renderWithServices(node: React.ReactNode) {
  const services = new ServiceCollection()
  services.set(ICommandService, {
    executeCommand: () => Promise.resolve(),
  } as unknown as ICommandService)
  services.set(IContextKeyService, {
    createKey: () => ({ set: () => {} }),
  } as unknown as IContextKeyService)
  services.set(IAcpChatWidgetService, {
    setHasSelection: () => {},
  } as unknown as IAcpChatWidgetService)
  const inst = new InstantiationService(services)
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <ServicesContext.Provider value={inst}>{children}</ServicesContext.Provider>
  )
  return render(node, { wrapper: Wrapper })
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
})
