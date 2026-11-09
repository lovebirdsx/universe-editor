import { MAX_ATTACHMENTS_PER_PROMPT } from '@universe-editor/mobile-protocol'
import type { AcpChildItem, AcpToolCall } from '../../acp/session/acpSession.js'
import type { AcpMessage } from '../../acp/session/acpSessionModel.js'
import { describe, expect, it } from 'vitest'
import {
  diffMessage,
  projectMessage,
  projectToolCall,
  type TimelineProjectionContext,
} from '../mobileBridgeProjection.js'

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

function userMessage(overrides: Partial<AcpMessage> = {}): AcpMessage {
  return {
    id: 'm1',
    role: 'user',
    text: 'hello',
    blocks: [{ type: 'text', text: 'hello' }],
    streaming: false,
    messageId: 'msg-1',
    ...overrides,
  }
}

const FORKABLE: TimelineProjectionContext = {
  firstUserId: 'm0',
  forkSupported: true,
  readOnly: false,
}

describe('projectMessage rewind / fork anchors', () => {
  it('projects the anchor and canFork for a non-first user turn', () => {
    expect(projectMessage(userMessage(), FORKABLE)).toMatchObject({
      messageId: 'msg-1',
      canFork: true,
    })
  })

  it('marks the first user turn rewind-only', () => {
    expect(projectMessage(userMessage({ id: 'm0' }), FORKABLE)).toMatchObject({
      messageId: 'msg-1',
      canFork: false,
    })
  })

  it('omits both fields for auto-retry and non-user messages', () => {
    expect(projectMessage(userMessage({ autoRetry: true }), FORKABLE)).not.toHaveProperty(
      'messageId',
    )
    expect(projectMessage(userMessage({ autoRetry: true }), FORKABLE)).not.toHaveProperty('canFork')
    expect(
      projectMessage(userMessage({ id: 'm2', role: 'agent' }), FORKABLE),
    ).not.toHaveProperty('messageId')
  })

  it('keeps the anchor but disables fork for read-only or unsupported agents', () => {
    expect(
      projectMessage(userMessage(), { ...FORKABLE, readOnly: true }),
    ).toMatchObject({ canFork: false })
    expect(
      projectMessage(userMessage(), { ...FORKABLE, forkSupported: false }),
    ).toMatchObject({ canFork: false })
  })

  it('omits canFork when the caller has no timeline context', () => {
    const projected = projectMessage(userMessage())
    expect(projected).toMatchObject({ messageId: 'msg-1' })
    expect(projected).not.toHaveProperty('canFork')
  })
})

describe('diffMessage anchors', () => {
  it('re-emits the anchor on a text append so the phone store keeps it', () => {
    const previous = projectMessage(userMessage({ text: 'hel' }), FORKABLE)
    const next = projectMessage(userMessage({ text: 'hello' }), FORKABLE)
    expect(diffMessage(previous, next)).toMatchObject({
      type: 'message_upsert',
      textAppend: 'lo',
      messageId: 'msg-1',
      canFork: true,
    })
  })

  it('emits an upsert when only canFork changes', () => {
    const previous = projectMessage(userMessage(), FORKABLE)
    const next = projectMessage(userMessage(), { ...FORKABLE, forkSupported: false })
    expect(diffMessage(previous, next)).toMatchObject({
      type: 'message_upsert',
      canFork: false,
    })
  })
})
