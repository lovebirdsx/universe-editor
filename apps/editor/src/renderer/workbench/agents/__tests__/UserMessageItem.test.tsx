/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for UserMessageItem's Rewind / Fork hover affordances (capability
 *  gating + command delegation) and its overflow-clamp stability: the measured
 *  overflow state must be remembered per contentKey so a virtualization remount
 *  seeds at the same height it settled at (the scroll-jitter fix).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import {
  ICommandService,
  InstantiationService,
  ServiceCollection,
  observableValue,
} from '@universe-editor/platform'
import type { ContentBlock } from '@agentclientprotocol/sdk'
import { UserMessageItem } from '../UserMessageItem.js'
import { ServicesContext } from '../../useService.js'
import type { IAcpSession } from '../../../services/acp/session/acpSessionService.js'
import {
  RewindAgentSessionAction,
  ForkAgentSessionAction,
} from '../../../actions/agentRewindActions.js'
import {
  _resetMeasuredOverflowForTests,
  initialOverflow,
  recallMeasuredOverflow,
} from '../contentOverflow.js'

vi.mock('../../editor/monaco/MonacoLoader.js', () => ({
  MonacoLoader: { ensureInitialized: () => new Promise(() => {}) },
}))

afterEach(() => cleanup())

function fakeSession(opts: { rewind?: boolean; fork?: boolean }): IAcpSession {
  return {
    id: 's1',
    agentId: opts.rewind ? 'claude-code' : 'fake',
    rewindSupported: observableValue<boolean>('t.rewind', opts.rewind ?? false),
    forkSupported: observableValue<boolean>('t.fork', opts.fork ?? false),
  } as unknown as IAcpSession
}

function renderItem(
  session: IAcpSession | undefined,
  messageId: string | undefined,
): { execute: ReturnType<typeof vi.fn>; container: HTMLElement } {
  const execute = vi.fn().mockResolvedValue(undefined)
  const services = new ServiceCollection()
  services.set(ICommandService, { executeCommand: execute } as unknown as ICommandService)
  const inst = new InstantiationService(services)
  const blocks: readonly ContentBlock[] = [{ type: 'text', text: 'hi' }]
  const { container } = render(
    <ServicesContext.Provider value={inst}>
      <UserMessageItem
        blocks={blocks}
        {...(session !== undefined ? { session } : {})}
        {...(messageId !== undefined ? { messageId } : {})}
      />
    </ServicesContext.Provider>,
  )
  return { execute, container }
}

describe('UserMessageItem — rewind / fork actions', () => {
  it('shows both buttons when supported and delegates with the right arg', () => {
    const { execute, container } = renderItem(fakeSession({ rewind: true, fork: true }), 'mid-1')
    const rewind = container.querySelector('[data-testid="acp-user-message-rewind"]')
    const fork = container.querySelector('[data-testid="acp-user-message-fork"]')
    expect(rewind).not.toBeNull()
    expect(fork).not.toBeNull()

    fireEvent.click(rewind!)
    expect(execute).toHaveBeenCalledWith(RewindAgentSessionAction.ID, {
      sessionId: 's1',
      messageId: 'mid-1',
    })
    fireEvent.click(fork!)
    expect(execute).toHaveBeenCalledWith(ForkAgentSessionAction.ID, {
      sessionId: 's1',
      messageId: 'mid-1',
    })
  })

  it('hides rewind when the agent does not support it', () => {
    const { container } = renderItem(fakeSession({ rewind: false, fork: true }), 'mid-1')
    expect(container.querySelector('[data-testid="acp-user-message-rewind"]')).toBeNull()
    expect(container.querySelector('[data-testid="acp-user-message-fork"]')).not.toBeNull()
  })

  it('renders no actions at all when neither capability is present', () => {
    const { container } = renderItem(fakeSession({ rewind: false, fork: false }), 'mid-1')
    expect(container.querySelector('[data-testid="acp-user-message-actions"]')).toBeNull()
  })

  it('renders no actions when the message has no messageId', () => {
    const { container } = renderItem(fakeSession({ rewind: true, fork: true }), undefined)
    expect(container.querySelector('[data-testid="acp-user-message-actions"]')).toBeNull()
  })
})

describe('UserMessageItem — overflow clamp stability', () => {
  beforeEach(() => _resetMeasuredOverflowForTests())

  const renderWithKey = (contentKey: string) => {
    const services = new ServiceCollection()
    const inst = new InstantiationService(services)
    const blocks: readonly ContentBlock[] = [{ type: 'text', text: '正文' }]
    return render(
      <ServicesContext.Provider value={inst}>
        <UserMessageItem blocks={blocks} contentKey={contentKey} />
      </ServicesContext.Provider>,
    )
  }

  // happy-dom has no layout, so scrollHeight is stubbed to simulate a body
  // taller than the 160px clamp.
  const stubScrollHeight = (px: number) => {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => px,
    })
    return () => {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)['scrollHeight']
    }
  }

  it('remembers the measured overflow per contentKey so a remount seeds from it', () => {
    const restore = stubScrollHeight(500)
    try {
      const { container, unmount } = renderWithKey('msg:m:1')
      const body = container.querySelector('[data-testid="acp-user-message-body"]')
      expect(body?.getAttribute('data-overflow')).toBe('true')
      expect(body?.getAttribute('data-collapsed')).toBe('true')
      // The measured truth is cached — a virtualization remount must mount
      // already clamped instead of flashing tall then clamping (the height
      // flip that feeds the scroll-correction loop).
      expect(recallMeasuredOverflow('msg:m:1')).toBe(true)
      unmount()
      expect(initialOverflow('msg:m:1', () => false)).toBe(true)
    } finally {
      restore()
    }
  })

  it('records non-overflowing bodies too, and expands via the toggle', () => {
    const restore = stubScrollHeight(500)
    try {
      const { container } = renderWithKey('msg:m:2')
      const toggle = container.querySelector('[data-testid="acp-user-message-toggle"]')
      expect(toggle).not.toBeNull()
      fireEvent.click(toggle!)
      const body = container.querySelector('[data-testid="acp-user-message-body"]')
      expect(body?.getAttribute('data-collapsed')).toBe('false')
    } finally {
      restore()
    }
    const restoreShort = stubScrollHeight(40)
    try {
      const { container } = renderWithKey('msg:m:3')
      const body = container.querySelector('[data-testid="acp-user-message-body"]')
      expect(body?.getAttribute('data-overflow')).toBe('false')
      expect(recallMeasuredOverflow('msg:m:3')).toBe(false)
    } finally {
      restoreShort()
    }
  })
})
