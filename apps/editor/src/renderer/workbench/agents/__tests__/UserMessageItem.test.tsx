/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for UserMessageItem's Rewind / Fork hover affordances: they appear only
 *  when the source session advertises the capability and a messageId is present,
 *  and clicking each delegates to the matching Action2 command with the
 *  { sessionId, messageId } argument.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
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
import type { IAcpSession } from '../../../services/acp/acpSessionService.js'
import {
  RewindAgentSessionAction,
  ForkAgentSessionAction,
} from '../../../actions/agentRewindActions.js'

vi.mock('../../editor/monaco/MonacoLoader.js', () => ({
  MonacoLoader: { ensureInitialized: () => new Promise(() => {}) },
}))

afterEach(() => cleanup())

function fakeSession(opts: { rewind?: boolean; fork?: boolean }): IAcpSession {
  return {
    id: 's1',
    agentId: opts.rewind ? 'claude-code' : 'fake',
    rewindSupported: opts.rewind ?? false,
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
