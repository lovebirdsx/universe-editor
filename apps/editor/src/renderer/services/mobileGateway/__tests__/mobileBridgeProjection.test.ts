import { MAX_ATTACHMENTS_PER_PROMPT } from '@universe-editor/mobile-protocol'
import type { AcpChildItem, AcpToolCall } from '../../acp/session/acpSession.js'
import type { AcpMessage } from '../../acp/session/acpSessionModel.js'
import { describe, expect, it } from 'vitest'
import { diffMessage, projectMessage, projectToolCall } from '../mobileBridgeProjection.js'

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

describe('projectMessage mobile attachments', () => {
  const attachmentMeta = {
    id: 'att-1',
    kind: 'image',
    name: 'shot.png',
    mimeType: 'image/png',
    size: 3,
  }

  function message(
    blocks: AcpMessage['blocks'],
    overrides: Partial<AcpMessage> = {},
  ): AcpMessage {
    return {
      id: 'm1',
      role: 'user',
      text: '',
      blocks,
      streaming: false,
      ...overrides,
    }
  }

  it('reports attachment metadata instead of the generic non-text note', () => {
    const projected = projectMessage(
      message([
        {
          type: 'image',
          data: 'AAA=',
          mimeType: 'image/png',
          _meta: { mobileAttachment: attachmentMeta },
        },
      ]),
    )
    expect(projected).toMatchObject({ attachments: [attachmentMeta] })
    expect(projected).not.toHaveProperty('hasNonText')
  })

  it('keeps hasNonText for blocks without a mobile attachment stamp', () => {
    const projected = projectMessage(
      message([
        { type: 'image', data: 'AAA=', mimeType: 'image/png' },
        { type: 'audio', data: 'AAA=', mimeType: 'audio/wav' },
      ]),
    )
    expect(projected).not.toHaveProperty('attachments')
    expect(projected).toMatchObject({ hasNonText: true })
  })

  it('treats stamps the phone would reject as plain non-text blocks', () => {
    const projected = projectMessage(
      message([
        {
          type: 'image',
          data: 'AAA=',
          mimeType: 'image/png',
          _meta: { mobileAttachment: { ...attachmentMeta, name: 'x'.repeat(300) } },
        },
      ]),
    )
    expect(projected).not.toHaveProperty('attachments')
    expect(projected).toMatchObject({ hasNonText: true })
  })

  it('caps projected attachments at the protocol limit', () => {
    const blocks: AcpMessage['blocks'] = Array.from(
      { length: MAX_ATTACHMENTS_PER_PROMPT + 1 },
      (_, index) => ({
        type: 'image' as const,
        data: 'AAA=',
        mimeType: 'image/png',
        _meta: { mobileAttachment: { ...attachmentMeta, id: `att-${index}` } },
      }),
    )
    const projected = projectMessage(message(blocks))
    expect(projected).toMatchObject({
      attachments: expect.any(Array),
      hasNonText: true,
    })
    expect(projected.attachments).toHaveLength(MAX_ATTACHMENTS_PER_PROMPT)
  })

  it('diffs attachment arrays and clears them explicitly', () => {
    const withAttachment = projectMessage(
      message([
        {
          type: 'image',
          data: 'AAA=',
          mimeType: 'image/png',
          _meta: { mobileAttachment: attachmentMeta },
        },
      ]),
    )
    const withoutAttachment = projectMessage(message([]))
    expect(diffMessage(withAttachment, withAttachment)).toBeUndefined()
    expect(diffMessage(withAttachment, withoutAttachment)).toMatchObject({
      type: 'message_upsert',
      attachments: [],
    })
  })
})
