import type {
  MobileTimelineMessageItem,
  MobileTimelineToolCallItem,
} from '@universe-editor/mobile-protocol'
import { describe, expect, it } from 'vitest'
import { strings } from '../../strings.js'
import {
  DEFAULT_SESSION_DISPLAY,
  SESSION_DISPLAY_STORAGE_KEY,
  getHiddenActivity,
  readSessionDisplayPreference,
  selectTimelineForDisplay,
  setSessionDisplayPreference,
} from '../sessionDisplay.js'

function message(
  id: string,
  role: MobileTimelineMessageItem['role'],
  text: string,
  overrides: Partial<MobileTimelineMessageItem> = {},
): MobileTimelineMessageItem {
  return { kind: 'message', id, role, text, streaming: false, ...overrides }
}

function toolCall(
  id: string,
  overrides: Partial<MobileTimelineToolCallItem> = {},
): MobileTimelineToolCallItem {
  return {
    kind: 'toolCall',
    id,
    title: `Tool ${id}`,
    toolKind: 'execute',
    status: 'completed',
    hasDetail: true,
    ...overrides,
  }
}

const notice = {
  kind: 'notice',
  id: 'notice-1',
  noticeKind: 'compaction',
  phase: 'success',
} as const

describe('selectTimelineForDisplay', () => {
  it('returns the original timeline reference in full mode', () => {
    const timeline = [message('m1', 'user', 'hello')]
    expect(selectTimelineForDisplay(timeline, 'full')).toBe(timeline)
  })

  it('keeps messages, errors, notices and the always-kept tool cards', () => {
    const timeline = [
      message('u1', 'user', 'hello'),
      message('a1', 'agent', 'answer'),
      message('e1', 'agent', '[error] boom'),
      message('s1', 'agent', '', { streaming: true }),
      message('n1', 'agent', '', { hasNonText: true }),
      message('i1', 'agent', '', { images: [{ index: 0, mimeType: 'image/png', size: 3 }] }),
      notice,
      toolCall('t1', { subagent: true }),
      toolCall('t2', { requiresUserDecision: true }),
      toolCall('t3', { toolKind: 'switch_mode' }),
    ]

    expect(selectTimelineForDisplay(timeline, 'onlyMessage')).toStrictEqual(timeline)
  })

  it('drops thoughts, ordinary tools and empty settled agent messages', () => {
    const timeline = [
      message('th1', 'thought', 'thinking'),
      toolCall('t1'),
      toolCall('t2', { status: 'failed' }),
      message('a1', 'agent', ''),
      message('a2', 'agent', '   '),
    ]

    expect(selectTimelineForDisplay(timeline, 'onlyMessage')).toStrictEqual([])
  })

  it('keeps a memory-trimmed user message as an anchor', () => {
    const trimmed = message('u1', 'user', '', { memoryTrimmed: true })
    expect(selectTimelineForDisplay([trimmed], 'onlyMessage')).toStrictEqual([trimmed])
  })
})

describe('getHiddenActivity', () => {
  it('stays silent when inactive, in full mode, or when the tail is visible', () => {
    const thought = message('th1', 'thought', 'thinking')
    expect(getHiddenActivity([], thought, 'onlyMessage', false)).toBeNull()
    expect(getHiddenActivity([thought], thought, 'full', true)).toBeNull()
    expect(getHiddenActivity([thought], thought, 'onlyMessage', true)).toBeNull()
  })

  it('summarizes the first non-empty thought line', () => {
    const thought = message('th1', 'thought', '\n\n  Let me inspect the file  \nmore')
    expect(getHiddenActivity([], thought, 'onlyMessage', true)).toStrictEqual({
      kind: 'thinking',
      detail: 'Let me inspect the file',
    })
  })

  it('returns a bare thinking hint when the thought is empty', () => {
    const thought = message('th1', 'thought', '   ')
    expect(getHiddenActivity([], thought, 'onlyMessage', true)).toStrictEqual({
      kind: 'thinking',
    })
  })

  it('describes a running tool with its target and start time', () => {
    const tool = toolCall('t1', {
      status: 'in_progress',
      locations: [{ path: 'src/a.ts', line: 12 }],
      startedAt: 1_000,
    })
    expect(getHiddenActivity([], tool, 'onlyMessage', true)).toStrictEqual({
      kind: 'tool',
      title: 'Tool t1',
      detail: 'src/a.ts:12',
      startedAt: 1_000,
    })
  })

  it('falls back to a diff path and then to the fallback title', () => {
    const tool = toolCall('t2', {
      status: 'pending',
      title: '   ',
      diffs: [{ path: 'src/b.ts', added: 1, removed: 0 }],
    })
    expect(getHiddenActivity([], tool, 'onlyMessage', true)).toStrictEqual({
      kind: 'tool',
      title: strings.activityToolFallback,
      detail: 'src/b.ts',
    })
  })

  it('reports the previous settled tool with its failure reason and span', () => {
    const failed = toolCall('t3', {
      status: 'failed',
      durationMs: 1_500,
      preview: '```console\n\x1b[31mboom\x1b[0m\n```',
    })
    expect(getHiddenActivity([], failed, 'onlyMessage', true)).toStrictEqual({
      kind: 'settledTool',
      tool: {
        title: 'Tool t3',
        status: 'failed',
        reason: 'boom',
        durationMs: 1_500,
      },
    })
  })

  it('prefers the settle reason and synthetic-denial wording over the preview', () => {
    const cancelled = toolCall('t4', { status: 'cancelled', settleReason: 'orphaned' })
    expect(getHiddenActivity([], cancelled, 'onlyMessage', true)).toStrictEqual({
      kind: 'settledTool',
      tool: { title: 'Tool t4', status: 'cancelled', reason: 'orphaned' },
    })

    const denial = toolCall('t5', {
      status: 'failed',
      syntheticDenial: true,
      preview: 'User rejected request to exit plan mode.',
    })
    expect(getHiddenActivity([], denial, 'onlyMessage', true)).toStrictEqual({
      kind: 'settledTool',
      tool: {
        title: 'Tool t5',
        status: 'failed',
        reason: strings.activitySyntheticDenial,
      },
    })
  })

  it('ignores a truncated fence marker when deriving a failure reason', () => {
    const failed = toolCall('t6', { status: 'failed', preview: '```console\nError: nope' })
    expect(getHiddenActivity([], failed, 'onlyMessage', true)).toStrictEqual({
      kind: 'settledTool',
      tool: { title: 'Tool t6', status: 'failed', reason: 'Error: nope' },
    })
  })

  it('returns null for a visible agent tail and for notices', () => {
    const agent = message('a1', 'agent', 'answer')
    expect(getHiddenActivity([agent], agent, 'onlyMessage', true)).toBeNull()
    expect(getHiddenActivity([], notice, 'onlyMessage', true)).toBeNull()
  })
})

describe('session display preference', () => {
  it('defaults to only-message', () => {
    expect(DEFAULT_SESSION_DISPLAY).toBe('onlyMessage')
    expect(readSessionDisplayPreference()).toBe('onlyMessage')
  })

  it('persists and reads the full mode', () => {
    setSessionDisplayPreference('full')
    expect(localStorage.getItem(SESSION_DISPLAY_STORAGE_KEY)).toBe('full')
    expect(readSessionDisplayPreference()).toBe('full')
  })

  it('falls back to only-message for an unknown stored value', () => {
    localStorage.setItem(SESSION_DISPLAY_STORAGE_KEY, 'expanded')
    expect(readSessionDisplayPreference()).toBe('onlyMessage')
  })
})
