/*---------------------------------------------------------------------------------------------
 *  AcpSession × the shared resident budget. Each session already bounds itself,
 *  but a window holding several resumed sessions multiplied that ceiling by the
 *  number of sessions — the shape of the renderer OOM this guards. Here two
 *  sessions share one small budget: the one that stopped ingesting gives its
 *  content up so the active one can keep streaming.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { NoopTelemetryService } from '@universe-editor/platform'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { AcpSession } from '../acpSession.js'
import { AcpResidentBudget, type IAcpResidentBudget } from '../acpResidentBudget.js'
import { VIEW_MODEL_OVERHEAD_FACTOR } from '../acpContentLimits.js'
import { StubSessionChangeTracker } from './stubSessionChangeTracker.js'

/** Per-session budgets set high so only the shared one can bite. */
const PER_SESSION_BUDGET = 1024 * 1024 * 1024

function createSession(id: string, budget: IAcpResidentBudget): AcpSession {
  return new AcpSession(
    id,
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
    PER_SESSION_BUDGET,
    PER_SESSION_BUDGET,
    undefined,
    undefined,
    budget,
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

describe('AcpSession — shared resident budget', () => {
  const sessions: AcpSession[] = []

  afterEach(() => {
    for (const s of sessions.splice(0)) s.dispose()
    vi.restoreAllMocks()
  })

  function open(id: string, budget: IAcpResidentBudget): AcpSession {
    const session = createSession(id, budget)
    sessions.push(session)
    return session
  }

  it('releases the idle session’s content so the active one keeps its newest output', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // 800 chars → 1600 wire bytes → 4800 charged each. Two cards fit, three don't.
    const budget = new AcpResidentBudget(2 * 800 * 2 * VIEW_MODEL_OVERHEAD_FACTOR)
    const idle = open('idle', budget)
    const active = open('active', budget)

    idle.applyUpdate(terminalToolCall('idle-a', 'i'.repeat(800)))
    active.applyUpdate(terminalToolCall('active-a', 'a'.repeat(800)))
    active.applyUpdate(terminalToolCall('active-b', 'b'.repeat(800)))

    expect(idle.toolCalls.get()[0]?.memoryTrimmed).toBe(true)
    expect(active.toolCalls.get().map((c) => c.memoryTrimmed)).toEqual([undefined, undefined])
  })

  it('falls back to the active session once the idle one has nothing left', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const budget = new AcpResidentBudget(800 * 2 * VIEW_MODEL_OVERHEAD_FACTOR)
    const idle = open('idle', budget)
    const active = open('active', budget)

    idle.applyUpdate(terminalToolCall('idle-a', 'i'.repeat(800)))
    active.applyUpdate(terminalToolCall('active-a', 'a'.repeat(800)))
    active.applyUpdate(terminalToolCall('active-b', 'b'.repeat(800)))

    expect(idle.toolCalls.get()[0]?.memoryTrimmed).toBe(true)
    const activeCalls = active.toolCalls.get()
    expect(activeCalls[0]?.memoryTrimmed).toBe(true)
    // The newest output always survives — that is the whole point of trimming
    // oldest-first rather than rejecting new updates.
    expect(activeCalls[1]?.memoryTrimmed).toBeUndefined()
    expect(activeCalls[1]?.text).toBe('b'.repeat(800))
  })

  it('stops charging a closed session against the shared budget', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const budget = new AcpResidentBudget(2 * 800 * 2 * VIEW_MODEL_OVERHEAD_FACTOR)
    const closing = open('closing', budget)
    const active = open('active', budget)

    closing.applyUpdate(terminalToolCall('closing-a', 'c'.repeat(800)))
    expect(budget.totalBytes()).toBeGreaterThan(0)

    closing.dispose()
    expect(budget.totalBytes()).toBe(0)

    active.applyUpdate(terminalToolCall('active-a', 'a'.repeat(800)))
    active.applyUpdate(terminalToolCall('active-b', 'b'.repeat(800)))
    expect(active.toolCalls.get().map((c) => c.memoryTrimmed)).toEqual([undefined, undefined])
  })
})
