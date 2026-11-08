import type {
  MobileTimelineMessageItem,
  MobileTimelineToolCallItem,
} from '@universe-editor/mobile-protocol'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SESSION_DISPLAY,
  SESSION_DISPLAY_STORAGE_KEY,
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
