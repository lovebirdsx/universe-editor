/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for StickyUserMessageBar — derives the latest user message from the
 *  timeline, starts collapsed, expands on click, and tracks the last message.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { observableValue } from '@universe-editor/platform'
import type { IAcpSession, TimelineItem } from '../../../services/acp/acpSessionService.js'
import { StickyUserMessageBar } from '../StickyUserMessageBar.js'

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

describe('StickyUserMessageBar', () => {
  it('renders nothing when there is no user message', () => {
    render(<StickyUserMessageBar session={makeSession('s-empty', [])} />)
    expect(screen.queryByTestId('acp-user-bar')).toBeNull()
  })

  it('starts collapsed showing the summary, then expands to the full content', () => {
    render(
      <StickyUserMessageBar
        session={makeSession('s-one', [message('u1', 'user', 'Hello world')])}
      />,
    )
    expect(screen.getByTestId('acp-user-bar')).toBeTruthy()
    // Collapsed: summary text shows, full markdown body is not mounted.
    expect(screen.getByText('Hello world')).toBeTruthy()
    expect(screen.queryByTestId('acp-markdown')).toBeNull()
    fireEvent.click(screen.getByTestId('acp-collapsible-toggle'))
    const md = screen.getByTestId('acp-markdown')
    expect(md.textContent).toContain('Hello world')
  })

  it('shows the last user message when several exist', () => {
    render(
      <StickyUserMessageBar
        session={makeSession('s-many', [
          message('u1', 'user', 'first request'),
          message('a1', 'agent', 'some reply'),
          message('u2', 'user', 'second request'),
        ])}
      />,
    )
    expect(screen.getByText('second request')).toBeTruthy()
    expect(screen.queryByText('first request')).toBeNull()
  })
})
