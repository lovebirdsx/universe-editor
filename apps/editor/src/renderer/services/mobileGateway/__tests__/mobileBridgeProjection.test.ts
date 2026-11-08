import type { AcpChildItem, AcpToolCall } from '../../acp/session/acpSession.js'
import { describe, expect, it } from 'vitest'
import { projectToolCall } from '../mobileBridgeProjection.js'

function toolCall(overrides: Partial<AcpToolCall> = {}): AcpToolCall {
  return {
    id: 'tool-1',
    title: 'Edit file',
    kind: 'edit',
    status: 'completed',
    text: 'applied',
    blocks: [],
    diffs: [],
    ...overrides,
  }
}

const childMessage: AcpChildItem = {
  kind: 'message',
  id: 'child-1',
  message: {
    id: 'child-1',
    role: 'agent',
    text: 'nested',
    blocks: [],
    streaming: false,
  },
}

describe('projectToolCall only-message flags', () => {
  it('omits both flags for an ordinary tool call', () => {
    const projected = projectToolCall(toolCall())
    expect(projected).not.toHaveProperty('subagent')
    expect(projected).not.toHaveProperty('requiresUserDecision')
  })

  it('projects the desktop subagent predicate from the flag or nested children', () => {
    expect(projectToolCall(toolCall({ subagent: true }))).toMatchObject({ subagent: true })
    expect(projectToolCall(toolCall({ children: [childMessage] }))).toMatchObject({
      subagent: true,
    })
  })

  it('projects the user-decision flag even without a subagent timeline', () => {
    expect(projectToolCall(toolCall({ requiresUserDecision: true }))).toMatchObject({
      requiresUserDecision: true,
    })
    expect(projectToolCall(toolCall({ kind: 'switch_mode' }))).not.toHaveProperty(
      'requiresUserDecision',
    )
  })
})
