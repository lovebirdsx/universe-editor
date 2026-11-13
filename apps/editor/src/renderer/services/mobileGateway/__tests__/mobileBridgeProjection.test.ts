import {
  MAX_ATTACHMENTS_PER_PROMPT,
  MAX_IMAGES_PER_MESSAGE,
  MAX_MOBILE_COMMANDS,
} from '@universe-editor/mobile-protocol'
import type { AvailableCommand } from '@agentclientprotocol/sdk'
import type { AcpChildItem, AcpToolCall } from '../../acp/session/acpSession.js'
import type { AcpMessage } from '../../acp/session/acpSessionModel.js'
import { describe, expect, it } from 'vitest'
import {
  diffAvailableCommands,
  diffMessage,
  projectAutomationSummary,
  projectAvailableCommands,
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

describe('projectAutomationSummary', () => {
  it('projects trigger provenance plus the finished verdict', () => {
    expect(
      projectAutomationSummary({
        triggerId: 'swarm-triage',
        triggerName: 'Swarm triage',
        eventKey: 'swarm:1001',
        runId: 'run-1',
        verdict: 'escalate',
        summary: 'needs a human',
        outcome: 'completed',
      }),
    ).toStrictEqual({
      triggerName: 'Swarm triage',
      verdict: 'escalate',
      summary: 'needs a human',
      outcome: 'completed',
    })
  })

  it('omits the result fields while the run is still in flight', () => {
    expect(
      projectAutomationSummary({
        triggerId: 'swarm-triage',
        triggerName: 'Swarm triage',
        eventKey: 'swarm:1001',
        runId: 'run-1',
      }),
    ).toStrictEqual({ triggerName: 'Swarm triage' })
  })
})

describe('projectAvailableCommands', () => {
  const command = (overrides: Record<string, unknown> = {}): AvailableCommand =>
    ({
      name: 'compact',
      description: 'Compact the conversation',
      ...overrides,
    }) as unknown as AvailableCommand

  it('strips leading slashes and projects the argument hint', () => {
    expect(
      projectAvailableCommands([
        command({ name: '/compact', input: { hint: 'instructions' } }),
        command({ name: 'mcp:github:review', description: '  Review\n a PR  ' }),
      ]),
    ).toStrictEqual([
      { name: 'compact', description: 'Compact the conversation', inputHint: 'instructions' },
      { name: 'mcp:github:review', description: 'Review a PR' },
    ])
  })

  it('drops empty or whitespace names and de-duplicates case-insensitively', () => {
    expect(
      projectAvailableCommands([
        command({ name: '/' }),
        command({ name: 'two words' }),
        command({ name: 'Status' }),
        command({ name: '/status', description: 'duplicate' }),
      ]),
    ).toStrictEqual([{ name: 'Status', description: 'Compact the conversation' }])
  })

  it('caps the command count', () => {
    const commands = Array.from({ length: MAX_MOBILE_COMMANDS + 5 }, (_, index) =>
      command({ name: `cmd-${index}` }),
    )
    expect(projectAvailableCommands(commands)).toHaveLength(MAX_MOBILE_COMMANDS)
  })

  it('emits a snapshot event only when the projection changed', () => {
    const commands = [{ name: 'status', description: 'Show status' }]
    expect(diffAvailableCommands(commands, commands)).toBeUndefined()
    expect(diffAvailableCommands([], commands)).toStrictEqual({
      type: 'available_commands_snapshot',
      commands,
    })
  })
})

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

describe('projectToolCall activity timing', () => {
  it('projects timing and settlement fields', () => {
    expect(
      projectToolCall(
        toolCall({
          startedAt: 1_700_000_000_000,
          durationMs: 5_000,
          settleReason: 'cancelled',
          syntheticDenial: true,
        }),
      ),
    ).toMatchObject({
      startedAt: 1_700_000_000_000,
      durationMs: 5_000,
      settleReason: 'cancelled',
      syntheticDenial: true,
    })
  })

  it('omits timing fields for an ordinary tool call', () => {
    const projected = projectToolCall(toolCall())
    expect(projected).not.toHaveProperty('startedAt')
    expect(projected).not.toHaveProperty('durationMs')
    expect(projected).not.toHaveProperty('settleReason')
    expect(projected).not.toHaveProperty('syntheticDenial')
  })

  it('drops invalid timings and empty settle reasons', () => {
    const projected = projectToolCall(
      toolCall({ startedAt: -1, durationMs: 1.5, settleReason: '' }),
    )
    expect(projected).not.toHaveProperty('startedAt')
    expect(projected).not.toHaveProperty('durationMs')
    expect(projected).not.toHaveProperty('settleReason')
  })

  it('clamps an oversized settle reason to the wire limit', () => {
    const projected = projectToolCall(toolCall({ settleReason: 'x'.repeat(1_500) }))
    expect(projected.settleReason).toHaveLength(1_024)
    expect(projected.settleReason?.endsWith('…')).toBe(true)
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

  function message(blocks: AcpMessage['blocks'], overrides: Partial<AcpMessage> = {}): AcpMessage {
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

  it('projects file attachments and drops their text placeholder when images are rebuilt', () => {
    const fileMeta = {
      id: 'att-2',
      kind: 'file',
      name: 'notes.txt',
      mimeType: 'text/plain',
      size: 5,
    }
    const projected = projectMessage(
      message([
        { type: 'text', text: 'look' },
        {
          type: 'image',
          data: 'AAA=',
          mimeType: 'image/png',
          _meta: { mobileAttachment: attachmentMeta },
        },
        {
          type: 'resource_link',
          uri: 'file:///tmp/notes.txt',
          name: 'notes.txt',
          mimeType: 'text/plain',
          size: 5,
          _meta: { mobileAttachment: fileMeta },
        },
        { type: 'text', text: 'done' },
      ]),
    )
    expect(projected.attachments).toEqual([attachmentMeta, fileMeta])
    expect(projected).not.toHaveProperty('hasNonText')
    expect(projected.text).toBe('lookdone')
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

describe('projectMessage mobile images', () => {
  function message(blocks: AcpMessage['blocks'], overrides: Partial<AcpMessage> = {}): AcpMessage {
    return {
      id: 'm1',
      role: 'agent',
      text: '',
      blocks,
      streaming: false,
      ...overrides,
    }
  }

  it('projects plain image blocks and drops their text placeholders', () => {
    const projected = projectMessage(
      message([
        { type: 'text', text: 'before' },
        { type: 'image', data: 'AAA=', mimeType: 'image/png' },
        { type: 'text', text: 'after' },
      ]),
    )
    expect(projected).toMatchObject({
      images: [{ index: 0, mimeType: 'image/png', size: 2 }],
      text: 'beforeafter',
    })
    expect(projected).not.toHaveProperty('hasNonText')
  })

  it('keeps the image ordinal correct when attachments precede plain images', () => {
    const projected = projectMessage(
      message([
        {
          type: 'image',
          data: 'AAA=',
          mimeType: 'image/png',
          _meta: {
            mobileAttachment: {
              id: 'att-1',
              kind: 'image',
              name: 'shot.png',
              mimeType: 'image/png',
              size: 3,
            },
          },
        },
        { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' },
        { type: 'text', text: 'caption' },
      ]),
    )
    expect(projected.attachments).toHaveLength(1)
    expect(projected.images).toEqual([{ index: 1, mimeType: 'image/jpeg', size: 3 }])
    expect(projected.text).toBe('caption')
  })

  it('marks truncated payloads without requesting them', () => {
    const projected = projectMessage(
      message([
        {
          type: 'image',
          data: '',
          mimeType: 'image/png',
          _meta: { 'universe-editor/truncated': true },
        },
      ]),
    )
    expect(projected.images).toEqual([
      { index: 0, mimeType: 'image/png', size: 0, truncated: true },
    ])
  })

  it('keeps hasNonText for images the phone cannot render', () => {
    const projected = projectMessage(
      message([{ type: 'image', data: 'AAA=', mimeType: 'image/svg+xml' }]),
    )
    expect(projected).not.toHaveProperty('images')
    expect(projected).toMatchObject({ hasNonText: true })
  })

  it('caps projected images and keeps the rest as non-text content', () => {
    const blocks: AcpMessage['blocks'] = Array.from({ length: MAX_IMAGES_PER_MESSAGE + 1 }, () => ({
      type: 'image' as const,
      data: 'AAA=',
      mimeType: 'image/png',
    }))
    const projected = projectMessage(message(blocks))
    expect(projected.images).toHaveLength(MAX_IMAGES_PER_MESSAGE)
    expect(projected).toMatchObject({ hasNonText: true })
    expect(projected.text).toBe('[image: image/png]')
  })

  it('diffs image arrays and clears them explicitly', () => {
    const withImage = projectMessage(
      message([{ type: 'image', data: 'AAA=', mimeType: 'image/png' }]),
    )
    const withoutImage = projectMessage(message([]))
    expect(diffMessage(withImage, withImage)).toBeUndefined()
    expect(diffMessage(withImage, withoutImage)).toMatchObject({
      type: 'message_upsert',
      images: [],
    })
    expect(diffMessage(withoutImage, withImage)).toMatchObject({
      type: 'message_upsert',
      images: [{ index: 0, mimeType: 'image/png', size: 2 }],
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
    expect(projectMessage(userMessage({ id: 'm2', role: 'agent' }), FORKABLE)).not.toHaveProperty(
      'messageId',
    )
  })

  it('keeps the anchor but disables fork for read-only or unsupported agents', () => {
    expect(projectMessage(userMessage(), { ...FORKABLE, readOnly: true })).toMatchObject({
      canFork: false,
    })
    expect(projectMessage(userMessage(), { ...FORKABLE, forkSupported: false })).toMatchObject({
      canFork: false,
    })
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
