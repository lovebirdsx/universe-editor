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
import {
  MAX_ORPHAN_PARENT_ENTRIES,
  MAX_TOOL_CALL_PARENT_ENTRIES,
  USER_PROMPT_MEDIA_CAP,
  VIEW_MODEL_OVERHEAD_FACTOR,
  estimateUpdateCost,
} from '../acpContentLimits.js'
import type { PromptImage } from '../../promptImage.js'
import { StubSessionChangeTracker } from './stubSessionChangeTracker.js'

const LIVE_BUDGET = 2048 * VIEW_MODEL_OVERHEAD_FACTOR

function createSession(
  liveIngestionBudget = LIVE_BUDGET,
  residentBudget = new AcpResidentBudget(Number.MAX_SAFE_INTEGER),
): AcpSession {
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
    undefined,
    // A private budget per session: these tests deliberately drive the resident
    // tally over budget, which would reconcile against — and trim — any other
    // session sharing the process-wide default.
    residentBudget,
  )
}

function terminalToolCall(id: string, text: string, subagent = false): SessionUpdate {
  return {
    sessionUpdate: 'tool_call',
    toolCallId: id,
    title: 'execute',
    kind: subagent ? 'think' : 'execute',
    status: 'in_progress',
    content: [],
    _meta: {
      terminal_output: { data: text },
      ...(subagent ? { claudeCode: { subagent: true } } : {}),
    },
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

/**
 * The budget's red line: the tally the trim decrements must agree with a fresh walk of
 * what the session actually holds. The tally is what the shared budget reads, so a
 * traversal that measured one structure and released another would keep reporting a
 * number nobody could ever reconcile — the session reads as under budget while the heap
 * keeps growing.
 */
function expectTallyMatchesMeasurement(s: AcpSession): void {
  const priv = s as unknown as { _residentBytes: number; _measureResidentBytes(): number }
  expect(priv._residentBytes).toBe(priv._measureResidentBytes())
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

  it('keeps the sub-agent marker on a trimmed card', () => {
    // A long-running sub-agent is exactly the card the trim loop reaches first,
    // and dropping the marker would flip its glyph back mid-run.
    session = createSession()
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    session.applyUpdate(terminalToolCall('tc-a', 'x'.repeat(800), true))
    session.applyUpdate(terminalToolCall('tc-b', 'y'.repeat(800)))

    const calls = session.toolCalls.get()
    expect(calls[0]?.memoryTrimmed).toBe(true)
    expect(calls[0]?.subagent).toBe(true)
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
    expectTallyMatchesMeasurement(session)
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

describe('AcpSession — tool-call parent index bound', () => {
  let session: AcpSession | undefined

  afterEach(() => {
    session?.dispose()
    session = undefined
    vi.restoreAllMocks()
  })

  /** A late update that drops `parentToolUseId` — it re-attaches to the parent
   *  card only if the session still remembers the link. */
  function lateUpdate(id: string): SessionUpdate {
    return { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed' }
  }

  it('remembers recent parent links and evicts the oldest beyond the cap', () => {
    // The index has no end-of-life signal (a PostToolUse update can land long
    // after its card settled), so it is bounded FIFO rather than pruned. It
    // used to grow for the life of the session with nothing ever capping it.
    session = createSession(Number.MAX_SAFE_INTEGER)
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    session.applyUpdate(terminalToolCall('parent', 'p'))
    for (let i = 0; i < MAX_TOOL_CALL_PARENT_ENTRIES + 1; i++) {
      session.applyUpdate(childToolCall('parent', `child-${i}`, 'c'))
    }

    const parentSlot = (): { children?: readonly unknown[] } | undefined => {
      const slot = session?.timeline
        .get()
        .find((it) => it.kind === 'toolCall' && it.id === 'parent')
      return slot?.kind === 'toolCall' ? slot.call : undefined
    }
    const childrenBefore = parentSlot()?.children?.length ?? 0

    // The newest link survives: a late update still routes under the parent.
    session.applyUpdate(lateUpdate(`child-${MAX_TOOL_CALL_PARENT_ENTRIES}`))
    expect(parentSlot()?.children?.length).toBe(childrenBefore)

    // The oldest link was evicted, so its late update can no longer resolve a
    // parent — it surfaces at the top level instead of nesting.
    session.applyUpdate(lateUpdate('child-0'))
    expect(session.toolCalls.get().some((c) => c.id === 'child-0')).toBe(true)
    expect(parentSlot()?.children?.length).toBe(childrenBefore)
  })
})

describe('AcpSession — accounting gaps', () => {
  let session: AcpSession | undefined

  afterEach(() => {
    session?.dispose()
    session = undefined
    vi.restoreAllMocks()
  })

  /** A prompt image big enough to matter, shaped like what the prompt UI builds. */
  function promptImage(id: string, dataBase64: string): PromptImage {
    return { id, mimeType: 'image/png', dataBase64, byteSize: dataBase64.length }
  }

  it('charges a locally appended user message, so its images reach the trimmer', async () => {
    // `applyUpdate` charges as it ingests; a message the user sends never passes
    // through it. Without an explicit charge, a session where the user attached a
    // screenshot every turn grew with nothing watching it — and because the trim can
    // only release what it measured, it could not have reclaimed those bytes either.
    const budget = new AcpResidentBudget(Number.MAX_SAFE_INTEGER)
    session = createSession(Number.MAX_SAFE_INTEGER, budget)
    const before = budget.totalBytes()

    void session.sendPrompt('look', undefined, undefined, [promptImage('i1', 'A'.repeat(40000))])

    expect(budget.totalBytes()).toBeGreaterThan(before)
  })

  it('releases a charged user message rather than leaving the tally high', async () => {
    const budget = new AcpResidentBudget(0)
    session = createSession(Number.MAX_SAFE_INTEGER, budget)
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    void session.sendPrompt('look', undefined, undefined, [promptImage('i1', 'A'.repeat(40000))])

    const [message] = session.messages.get()
    expect(message?.memoryTrimmed).toBe(true)
    // The tracer for "measure and release agree": everything heavy was released, so
    // the tally the measure would recompute is zero.
    expect(budget.totalBytes()).toBe(0)
  })

  it('caps an oversized user attachment instead of blanking a legitimate one', async () => {
    const budget = new AcpResidentBudget(Number.MAX_SAFE_INTEGER)
    session = createSession(Number.MAX_SAFE_INTEGER, budget)

    void session.sendPrompt('look', undefined, undefined, [
      promptImage('small', 'A'.repeat(3 * 1024 * 1024)),
      promptImage('huge', 'B'.repeat(USER_PROMPT_MEDIA_CAP + 1)),
    ])

    const blocks = session.messages.get()[0]?.blocks ?? []
    const media = blocks.filter((b) => b.type === 'image')
    // A 3MB screenshot is what the prompt UI lets the user attach on purpose —
    // blanking it would be a visible regression, so only the 8MB+ one is dropped.
    expect(media[0]?.type === 'image' && media[0].data.length).toBe(3 * 1024 * 1024)
    expect(media[1]?.type === 'image' && media[1].data).toBe('')
    expect(media[1]?.type === 'image' && media[1]._meta?.['universe-editor/truncated']).toBe(true)
  })

  it('charges, measures and releases children stashed for a parent that never landed', () => {
    // Orphans live off-timeline, so a measure that walked only the timeline reported
    // 0 for megabytes the trimmer could actually have freed — and the `freed === 0`
    // branch then latched that wrong number in. Release must walk the same stash.
    const budget = new AcpResidentBudget(0)
    session = createSession(Number.MAX_SAFE_INTEGER, budget)
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    session.applyUpdate(childToolCall('ghost', 'c1', 'c'.repeat(800)))
    expect(session.timeline.get()).toHaveLength(0)

    // Adopting the parent later is the only way to see the stashed child — and it
    // must arrive already trimmed, which only happens if the orphan stash was both
    // charged and walked by the release traversal.
    session.applyUpdate(terminalToolCall('ghost', 'p'))
    const adopted = session.toolCalls.get().find((c) => c.id === 'ghost')
    const child = adopted?.children?.[0]
    expect(child?.kind).toBe('toolCall')
    if (child?.kind !== 'toolCall') throw new Error('expected an adopted tool-call child')
    expect(child.call.memoryTrimmed).toBe(true)
    expect(child.call.text).toBe('')
    expect(budget.totalBytes()).toBe(0)
    expectTallyMatchesMeasurement(session)
  })

  it('evicts the oldest orphan parents and gives their bytes back', () => {
    const budget = new AcpResidentBudget(Number.MAX_SAFE_INTEGER)
    session = createSession(Number.MAX_SAFE_INTEGER, budget)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // The first orphan is far larger than every later one, so once the cap starts
    // evicting, losing it must outweigh each new small arrival.
    session.applyUpdate(childToolCall('ghost0', 'c0', 'x'.repeat(40000)))
    const peak = budget.totalBytes()
    for (let i = 1; i <= MAX_ORPHAN_PARENT_ENTRIES + 2; i++) {
      session.applyUpdate(childToolCall(`ghost${i}`, `c${i}`, 'y'.repeat(20)))
    }
    expect(budget.totalBytes()).toBeLessThan(peak)
    // Eviction charges the same bytes it releases, so the tally stays reconcilable.
    expectTallyMatchesMeasurement(session)

    // Children live on the timeline slot, not the toolCalls lane — read there.
    const adopted = (id: string): readonly unknown[] | undefined => {
      const slot = session?.timeline.get().find((it) => it.kind === 'toolCall' && it.id === id)
      return slot?.kind === 'toolCall' ? slot.call.children : undefined
    }

    // The evicted parent's children are gone for good...
    session.applyUpdate(terminalToolCall('ghost0', 'p'))
    expect(adopted('ghost0')).toBeUndefined()

    // ...while a recent one is still there to be adopted.
    const newest = `ghost${MAX_ORPHAN_PARENT_ENTRIES + 2}`
    session.applyUpdate(terminalToolCall(newest, 'p'))
    expect(adopted(newest)).toHaveLength(1)
    expect(warn).not.toHaveBeenCalled()
  })
})
