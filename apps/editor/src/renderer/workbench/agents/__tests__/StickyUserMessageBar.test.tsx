/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for StickyUserMessageBar — shows the user message for the section in
 *  view (by the activeUserKey ChatScroll reports), renders nothing when the key
 *  is null (section prompt still visible) or no longer resolves, starts expanded,
 *  collapses on click.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  ICommandService,
  IContextKeyService,
  InstantiationService,
  ServiceCollection,
  observableValue,
  type IObservable,
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

function key(value: string | null): IObservable<string | null> {
  return observableValue<string | null>('activeUserKey', value)
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
    renderWithServices(
      <StickyUserMessageBar session={makeSession('s-empty', [])} activeUserKey={key(null)} />,
    )
    expect(screen.queryByTestId('acp-user-bar')).toBeNull()
  })

  it('starts expanded showing the full content, then collapses to a summary on click', () => {
    renderWithServices(
      <StickyUserMessageBar
        session={makeSession('s-one', [message('u1', 'user', 'Hello world')])}
        activeUserKey={key('m:u1')}
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

  it('shows the user message for the section reported by activeUserKey', () => {
    renderWithServices(
      <StickyUserMessageBar
        session={makeSession('s-many', [
          message('u1', 'user', 'first request'),
          message('a1', 'agent', 'some reply'),
          message('u2', 'user', 'second request'),
        ])}
        activeUserKey={key('m:u1')}
      />,
    )
    expect(screen.getByText('first request')).toBeTruthy()
    expect(screen.queryByText('second request')).toBeNull()
  })

  it('renders nothing when the key is null (section prompt still visible)', () => {
    renderWithServices(
      <StickyUserMessageBar
        session={makeSession('s-fallback', [
          message('u1', 'user', 'first request'),
          message('a1', 'agent', 'some reply'),
          message('u2', 'user', 'second request'),
        ])}
        activeUserKey={key(null)}
      />,
    )
    expect(screen.queryByTestId('acp-user-bar')).toBeNull()
  })

  it('renders nothing when the key no longer resolves to a user message', () => {
    renderWithServices(
      <StickyUserMessageBar
        session={makeSession('s-gone', [message('u1', 'user', 'first request')])}
        activeUserKey={key('m:gone')}
      />,
    )
    expect(screen.queryByTestId('acp-user-bar')).toBeNull()
  })
})
