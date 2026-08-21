/*---------------------------------------------------------------------------------------------
 *  Live resident budget: outside of a history replay there is no ingest gate,
 *  so a long-running turn can accumulate hundreds of tool cards each retaining
 *  up to 1MB of terminal output. Once the live tally passes the budget the
 *  OLDEST heavy content is trimmed in place (card shell kept, marked
 *  `memoryTrimmed`), so the newest output always lands and the renderer cannot
 *  OOM. Budgets are injected small so the trim path is exercised cheaply.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { NoopTelemetryService } from '@universe-editor/platform'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { AcpSession, memoryTrimmedNotice } from '../acpSession.js'
import { estimateUpdateResidentBytes } from '../acpContentLimits.js'
import { StubSessionChangeTracker } from './stubSessionChangeTracker.js'

const LIVE_BUDGET = 2048

function createSession(liveIngestionBudget = LIVE_BUDGET): AcpSession {
  return new AcpSession(
    's1',
    'codex',
    't',
    new NoopTelemetryService(),
    undefined,
    'default',
    undefined,
    undefined,
    new StubSessionChangeTracker(),
    undefined,
    false,
    undefined,
    undefined,
    false,
    256 * 1024 * 1024,
    liveIngestionBudget,
  )
}

function terminalToolCall(id: string, text: string): SessionUpdate {
  return {
    sessionUpdate: 'tool_call',
    toolCallId: id,
    title: 'execute',
    kind: 'execute',
    status: 'in_progress',
    content: [],
    _meta: { terminal_output: { data: text } },
  }
}

function agentTextChunk(text: string): SessionUpdate {
  return { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }
}

/** A sub-agent tool call, nested onto `parentId` via the claudeCode meta bag. */
function childToolCall(parentId: string, id: string, text: string): SessionUpdate {
  return {
    sessionUpdate: 'tool_call',
    toolCallId: id,
    title: 'execute',
    kind: 'execute',
    status: 'in_progress',
    content: [],
    _meta: { terminal_output: { data: text }, claudeCode: { parentToolUseId: parentId } },
  }
}

describe('AcpSession — live resident budget', () => {
  let session: AcpSession | undefined

  afterEach(() => {
    session?.dispose()
    session = undefined
    vi.restoreAllMocks()
  })

  it('trims the oldest heavy tool card once over budget, keeping the newest intact', () => {
    session = createSession()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // 800 chars → 1600 bytes each. Two cards = 3200 > 2048 → the oldest is trimmed.
    session.applyUpdate(terminalToolCall('tc-a', 'x'.repeat(800)))
    session.applyUpdate(terminalToolCall('tc-b', 'y'.repeat(800)))

    const calls = session.toolCalls.get()
    expect(calls).toHaveLength(2)
    expect(calls[0]?.memoryTrimmed).toBe(true)
    expect(calls[0]?.text).toBe('')
    expect(calls[0]?.blocks).toHaveLength(0)
    expect(calls[0]?.title).toBe('execute')
    expect(calls[1]?.memoryTrimmed).toBeUndefined()
    expect(calls[1]?.text).toBe('y'.repeat(800))

    expect(warn).toHaveBeenCalled()
    expect(String(warn.mock.calls[0]?.[0])).toContain('s1')
    expect(String(warn.mock.calls[0]?.[0])).toContain('1600')
  })

  it('keeps trimming the oldest card until the tally is back under budget', () => {
    session = createSession()
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    session.applyUpdate(terminalToolCall('tc-a', 'x'.repeat(800)))
    session.applyUpdate(terminalToolCall('tc-b', 'y'.repeat(800)))
    session.applyUpdate(terminalToolCall('tc-c', 'z'.repeat(800)))

    const calls = session.toolCalls.get()
    expect(calls).toHaveLength(3)
    expect(calls[0]?.memoryTrimmed).toBe(true)
    expect(calls[1]?.memoryTrimmed).toBe(true)
    expect(calls[2]?.memoryTrimmed).toBeUndefined()
    expect(calls[2]?.text).toBe('z'.repeat(800))
  })

  it('trims old heavy messages when they are the oldest content', () => {
    session = createSession()
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    // 500 chars → 2000 bytes (block + text copy); then a 1600-byte tool card
    // pushes the tally to 3600 > 2048 → the older message is trimmed.
    session.applyUpdate(agentTextChunk('a'.repeat(500)))
    session.applyUpdate(terminalToolCall('tc-a', 'x'.repeat(800)))

    const messages = session.messages.get()
    expect(messages).toHaveLength(1)
    expect(messages[0]?.memoryTrimmed).toBe(true)
    expect(messages[0]?.text).toBe(memoryTrimmedNotice())

    const calls = session.toolCalls.get()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.memoryTrimmed).toBeUndefined()
    expect(calls[0]?.text).toBe('x'.repeat(800))
  })

  it('does not trim anything while the live tally is under budget', () => {
    session = createSession()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    session.applyUpdate(terminalToolCall('tc-a', 'x'.repeat(800)))

    const calls = session.toolCalls.get()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.memoryTrimmed).toBeUndefined()
    expect(calls[0]?.text).toBe('x'.repeat(800))
    expect(warn).not.toHaveBeenCalled()
  })

  it('does not trim replayed history against the live budget', () => {
    // Live budget tiny, replay budget huge: replayed updates are gated by the
    // replay budget (which drops on overflow), never trimmed by the live path.
    session = createSession(LIVE_BUDGET)
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    session.beginHistoryReplay()
    session.applyUpdate(agentTextChunk('a'.repeat(500)))
    session.endHistoryReplay()

    const messages = session.messages.get()
    expect(messages).toHaveLength(1)
    expect(messages[0]?.memoryTrimmed).toBeUndefined()
    expect(messages[0]?.text).toBe('a'.repeat(500))
  })

  it('trims sub-agent children so their charged bytes are actually released', () => {
    // Sub-agent content arrives as its own updates (charged to the budget) but
    // is retained nested on the parent card. If the trim measured or released
    // only the parent, the loop would keep re-picking a card it believes it
    // freed — the tally would never come back under budget.
    session = createSession()
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    session.applyUpdate(terminalToolCall('parent', 'p'.repeat(100)))
    session.applyUpdate(childToolCall('parent', 'child', 'c'.repeat(800)))
    session.applyUpdate(terminalToolCall('newest', 'n'.repeat(800)))

    const slot = session.timeline.get().find((it) => it.kind === 'toolCall' && it.id === 'parent')
    expect(slot?.kind).toBe('toolCall')
    if (slot?.kind !== 'toolCall') throw new Error('expected the parent tool-call slot')
    expect(slot.call.memoryTrimmed).toBe(true)
    expect(slot.call.text).toBe('')
    // The child shell survives (the card still renders) but its heavy text is gone.
    const child = slot.call.children?.[0]
    expect(child?.kind).toBe('toolCall')
    if (child?.kind !== 'toolCall') throw new Error('expected a nested tool-call child')
    expect(child.call.memoryTrimmed).toBe(true)
    expect(child.call.text).toBe('')

    const newest = session.toolCalls.get().find((c) => c.id === 'newest')
    expect(newest?.memoryTrimmed).toBeUndefined()
    expect(newest?.text).toBe('n'.repeat(800))
  })

  it('charges the transient rawOutput copy codex ships alongside terminal output', () => {
    // codex sends a command's output twice: once as _meta.terminal_output (kept)
    // and again as rawOutput.formatted_output (never read). Both cross the wire,
    // so an update carrying both must cost more than one carrying only the first.
    const text = 'x'.repeat(400)
    const withRawOutput: SessionUpdate = {
      ...(terminalToolCall('tc', text) as object),
      rawOutput: { formatted_output: text, exit_code: 0 },
    } as SessionUpdate

    expect(estimateUpdateResidentBytes(withRawOutput)).toBeGreaterThan(
      estimateUpdateResidentBytes(terminalToolCall('tc', text)),
    )
  })
})
