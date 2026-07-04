/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/acp/acpTimelineOutline.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  ACP_OUTLINE_LANGUAGE_ID,
  decodeAcpOutlineKind,
  timelineToOutline,
} from '../acpTimelineOutline.js'
import type { AcpMessage, AcpToolCall, TimelineItem } from '../acpSessionModel.js'

function msg(id: string, role: AcpMessage['role'], text: string): TimelineItem {
  return {
    kind: 'message',
    id,
    message: { id, role, text, blocks: [], streaming: false },
  }
}

function tool(
  id: string,
  title: string,
  kind: string,
  children?: readonly TimelineItem[],
): TimelineItem {
  const call: AcpToolCall = {
    id,
    title,
    kind,
    status: 'completed',
    text: '',
    blocks: [],
    diffs: [],
    ...(children ? { children } : {}),
  }
  return { kind: 'toolCall', id, call }
}

describe('acpTimelineOutline', () => {
  it('language id is stable', () => {
    expect(ACP_OUTLINE_LANGUAGE_ID).toBe('acp.session')
  })

  it('groups a turn: agent + tool nest under the preceding user message', () => {
    const { roots } = timelineToOutline([
      msg('m1', 'user', 'Hello there'),
      msg('m2', 'agent', 'Hi'),
      tool('t1', 'Read file.ts', 'read'),
    ])
    // One root per user turn; the agent reply nests under it and the tool call
    // nests under the agent reply.
    expect(roots.map((r) => r.name)).toEqual(['Hello there'])
    const agent = roots[0]!.children ?? []
    expect(agent.map((c) => c.name)).toEqual(['Hi'])
    expect((agent[0]!.children ?? []).map((c) => c.name)).toEqual(['Read file.ts'])
  })

  it('opens a new user turn as a sibling root, resetting the agent scope', () => {
    const { roots } = timelineToOutline([
      msg('m1', 'user', 'Q1'),
      msg('m2', 'agent', 'A1'),
      tool('t1', 'grep', 'search'),
      msg('m3', 'agent', 'A2'),
      msg('m4', 'user', 'Q2'),
      msg('m5', 'agent', 'A3'),
    ])
    expect(roots.map((r) => r.name)).toEqual(['Q1', 'Q2'])
    const q1 = roots[0]!.children ?? []
    expect(q1.map((c) => c.name)).toEqual(['A1', 'A2'])
    // The tool call nests under the *open agent* turn (A1), not A2.
    expect((q1[0]!.children ?? []).map((c) => c.name)).toEqual(['grep'])
    expect((q1[1]!.children ?? []).map((c) => c.name)).toEqual([])
    const q2 = roots[1]!.children ?? []
    expect(q2.map((c) => c.name)).toEqual(['A3'])
  })

  it('keeps a leading tool call (before any message) at the top level', () => {
    const { roots } = timelineToOutline([
      tool('t0', 'boot', 'execute'),
      msg('m1', 'user', 'Hi'),
      msg('m2', 'agent', 'Yo'),
    ])
    expect(roots.map((r) => r.name)).toEqual(['boot', 'Hi'])
    expect((roots[1]!.children ?? []).map((c) => c.name)).toEqual(['Yo'])
  })

  it('uses the message first line as the label, clamped', () => {
    const { roots } = timelineToOutline([msg('m1', 'user', 'first line\nsecond line')])
    expect(roots[0]!.name).toBe('first line')
  })

  it('falls back to the role when a message has no text', () => {
    const { roots } = timelineToOutline([msg('m1', 'thought', '')])
    expect(roots[0]!.name).toBe('thought')
  })

  it('uses the tool title, falling back to the kind', () => {
    const { roots } = timelineToOutline([tool('t1', '', 'execute')])
    expect(roots[0]!.name).toBe('execute')
  })

  it('prefers a friendly execute description over the raw command as the label', () => {
    const call: AcpToolCall = {
      id: 't1',
      title: 'git status',
      kind: 'execute',
      status: 'completed',
      text: '',
      blocks: [],
      diffs: [],
      rawInput: { command: 'git status', description: '查看工作区状态' },
    }
    const { roots } = timelineToOutline([{ kind: 'toolCall', id: 't1', call }])
    expect(roots[0]!.name).toBe('查看工作区状态')
  })

  it('nests sub-agent children under their parent tool call', () => {
    const { roots } = timelineToOutline([
      tool('t1', 'Task', 'other', [msg('c1', 'agent', 'sub work'), tool('c2', 'grep', 'search')]),
    ])
    expect(roots).toHaveLength(1)
    const children = roots[0]!.children ?? []
    expect(children.map((c) => c.name)).toEqual(['sub work', 'grep'])
  })

  it('assigns monotonic pseudo-lines in timeline order, parent range spanning descendants', () => {
    const { roots, lineByKey } = timelineToOutline([
      msg('m1', 'user', 'A'),
      tool('t1', 'Task', 'other', [msg('c1', 'agent', 'B')]),
    ])
    expect(lineByKey.get('m:m1')).toBe(1)
    expect(lineByKey.get('t:t1')).toBe(2)
    // Child slot keys are `/`-composed with the parent (see buildStickyKey).
    expect(lineByKey.get('t:t1/m:c1')).toBe(3)
    // The tool call groups under the open user turn, whose range must span down to
    // the deepest descendant (the sub-agent child at line 3).
    const user = roots[0]!
    expect(user.range.startLineNumber).toBe(1)
    expect(user.range.endLineNumber).toBe(3)
    const task = user.children![0]!
    expect(task.range.startLineNumber).toBe(2)
    expect(task.range.endLineNumber).toBe(3)
  })

  it('round-trips keyByLine / lineByKey', () => {
    const { keyByLine, lineByKey } = timelineToOutline([
      msg('m1', 'user', 'A'),
      tool('t1', 'Task', 'other'),
    ])
    for (const [line, key] of keyByLine) {
      expect(lineByKey.get(key)).toBe(line)
    }
  })

  it('encodes and decodes message roles', () => {
    for (const role of ['user', 'agent', 'thought'] as const) {
      const { roots } = timelineToOutline([msg('m1', role, 'x')])
      expect(decodeAcpOutlineKind(roots[0]!.kind)).toEqual({ type: 'message', role })
    }
  })

  it('encodes and decodes known tool kinds, unknown falling back to other', () => {
    const { roots: known } = timelineToOutline([tool('t1', 'x', 'execute')])
    expect(decodeAcpOutlineKind(known[0]!.kind)).toEqual({ type: 'tool', kind: 'execute' })

    const { roots: unknown } = timelineToOutline([tool('t2', 'y', 'totally-made-up')])
    expect(decodeAcpOutlineKind(unknown[0]!.kind)).toEqual({ type: 'tool', kind: 'other' })
  })

  it('returns empty maps and roots for an empty timeline', () => {
    const { roots, keyByLine, lineByKey } = timelineToOutline([])
    expect(roots).toEqual([])
    expect(keyByLine.size).toBe(0)
    expect(lineByKey.size).toBe(0)
  })
})
