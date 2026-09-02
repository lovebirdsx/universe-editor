/*---------------------------------------------------------------------------------------------
 *  Live resident budget: outside of a history replay there is no ingest gate,
 *  so a long-running turn can accumulate hundreds of tool cards each retaining
 *  up to 1MB of terminal output. Once the tally passes the budget the OLDEST
 *  heavy content is trimmed in place (card shell kept, marked `memoryTrimmed`),
 *  so the newest output always lands and the renderer cannot OOM. Budgets are
 *  injected small so the trim path is exercised cheaply, and are expressed in
 *  overhead-adjusted bytes (wire bytes × VIEW_MODEL_OVERHEAD_FACTOR).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { NoopTelemetryService } from '@universe-editor/platform'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { AcpSession, memoryTrimmedNotice } from '../acpSession.js'
import { AcpResidentBudget } from '../acpResidentBudget.js'
import { VIEW_MODEL_OVERHEAD_FACTOR, estimateUpdateCost } from '../acpContentLimits.js'
import { StubSessionChangeTracker } from './stubSessionChangeTracker.js'

const LIVE_BUDGET = 2048 * VIEW_MODEL_OVERHEAD_FACTOR

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
    undefined,
    undefined,
    // A private budget per session: these tests deliberately drive the resident
    // tally over budget, which would reconcile against — and trim — any other
    // session sharing the process-wide default.
    new AcpResidentBudget(Number.MAX_SAFE_INTEGER),
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

/** An edit tool call carrying a single diff — the shape a sub-agent result
 *  document arrives in (the fork fakes one so the saved file shows up). */
function editToolCall(id: string, path: string, newText: string): SessionUpdate {
  return {
    sessionUpdate: 'tool_call',
    toolCallId: id,
    title: `Saved Explore result: ${path}`,
    kind: 'edit',
    status: 'completed',
    content: [{ type: 'diff', path, oldText: null, newText }],
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

    // 800 chars → 1600 wire bytes → 4800 charged each. Two cards = 9600 > 6144
    // → the oldest is trimmed.
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
    expect(String(warn.mock.calls[0]?.[0])).toContain('4800')
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

    // 500 chars → 2000 wire bytes (block + text copy) → 6000 charged; then a
    // 4800-byte tool card pushes the tally to 10800 > 6144 → the older message
    // is trimmed.
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

  it('charges replayed history to the same resident tally and trims it too', () => {
    // A resumed transcript is resident content exactly like live output. The
    // tally used to ignore it, so a session restored from a huge history
    // reported ~0 bytes while holding all of it — several such sessions in one
    // window is what filled the V8 cage.
    session = createSession()
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    session.beginHistoryReplay()
    // 500 chars → 6000 charged, under the 6144 budget on its own.
    session.applyUpdate(agentTextChunk('a'.repeat(500)))
    expect(session.messages.get()[0]?.memoryTrimmed).toBeUndefined()
    // A live card on top pushes the total over — the replayed message is the
    // oldest content, so it is what gets released.
    session.endHistoryReplay()
    session.applyUpdate(terminalToolCall('tc-a', 'x'.repeat(800)))

    const messages = session.messages.get()
    expect(messages[0]?.memoryTrimmed).toBe(true)
    expect(session.toolCalls.get()[0]?.memoryTrimmed).toBeUndefined()
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

  it('keeps a trimmed edit card’s diff path while releasing both text sides', () => {
    // The path costs nothing (it was never charged to the budget) but the card's
    // affordances read it — a sub-agent result document keyed off the diff path
    // would otherwise lose its header preview button the moment it is trimmed.
    session = createSession()
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    session.applyUpdate(
      editToolCall('tc-doc', '.claude/explore-results/2026-doc.md', 'd'.repeat(1200)),
    )
    session.applyUpdate(terminalToolCall('tc-newest', 'n'.repeat(800)))

    const doc = session.toolCalls.get().find((c) => c.id === 'tc-doc')
    expect(doc?.memoryTrimmed).toBe(true)
    expect(doc?.diffs).toHaveLength(1)
    expect(doc?.diffs[0]?.path).toBe('.claude/explore-results/2026-doc.md')
    expect(doc?.diffs[0]?.oldText).toBe('')
    expect(doc?.diffs[0]?.newText).toBe('')
  })

  it('charges the transient rawOutput copy codex ships alongside terminal output', () => {
    // codex sends a command's output twice: once as _meta.terminal_output (kept)
    // and again as rawOutput.formatted_output (never read). The replay gate —
    // which bounds a peak — must count both; the resident tally must count only
    // the kept copy, since rawOutput is decoded and dropped, so no trim could
    // ever release bytes charged from it.
    const text = 'x'.repeat(400)
    const withRawOutput: SessionUpdate = {
      ...(terminalToolCall('tc', text) as object),
      rawOutput: { formatted_output: text, exit_code: 0 },
    } as SessionUpdate
    const plain = estimateUpdateCost(terminalToolCall('tc', text))
    const withExtra = estimateUpdateCost(withRawOutput)

    expect(withExtra.retained).toBe(plain.retained)
    expect(withExtra.transient).toBeGreaterThan(plain.transient)
  })

  it('never trims sibling cards over transient bytes (rawOutput) the cards cannot release', () => {
    // Regression for the phantom-bytes asymmetry: an update whose cost is
    // dominated by rawOutput must not push the resident tally over budget —
    // the previous estimator charged rawOutput to the resident tally while no
    // trim path could release it, so the trim loop stripped every card in the
    // session and the tally still reported over budget.
    session = createSession()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    session.applyUpdate(terminalToolCall('tc-a', 'a'.repeat(100)))
    const bigRawOutput: SessionUpdate = {
      ...(terminalToolCall('tc-b', 'b'.repeat(100)) as object),
      // Way beyond the injected budget if it were ever charged as resident.
      rawOutput: { formatted_output: 'r'.repeat(100_000), exit_code: 0 },
    } as SessionUpdate
    session.applyUpdate(bigRawOutput)

    const calls = session.toolCalls.get()
    expect(calls).toHaveLength(2)
    expect(calls[0]?.memoryTrimmed).toBeUndefined()
    expect(calls[1]?.memoryTrimmed).toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
  })
})
