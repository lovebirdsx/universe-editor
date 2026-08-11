/*---------------------------------------------------------------------------------------------
 *  Replay ingestion budget: while a session replays its history (session/load
 *  or rewind), the resident cost of the replayed updates is tallied. Past the
 *  budget the remaining updates are dropped instead of swelling the timeline
 *  (a restored multi-GB history was enough to OOM the renderer), and a system
 *  notice marks the truncation when the replay ends.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { NoopTelemetryService } from '@universe-editor/platform'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { AcpSession, replayHistoryOverflowNotice } from '../acpSession.js'
import { REPLAY_INGESTION_BUDGET } from '../acpContentLimits.js'
import { StubSessionChangeTracker } from './stubSessionChangeTracker.js'

const TEST_BUDGET = 1024

function createSession(replayIngestionBudget = TEST_BUDGET): AcpSession {
  return new AcpSession(
    's1',
    'claude-code',
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
    replayIngestionBudget,
  )
}

function agentTextChunk(text: string): SessionUpdate {
  return { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }
}

describe('AcpSession — replay ingestion budget', () => {
  let session: AcpSession | undefined

  afterEach(() => {
    session?.dispose()
    session = undefined
    vi.restoreAllMocks()
  })

  it('exports a 256MB default budget', () => {
    expect(REPLAY_INGESTION_BUDGET).toBe(256 * 1024 * 1024)
  })

  it('drops replayed updates past the budget, warns with the tally, and marks the truncation', () => {
    session = createSession()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    session.beginHistoryReplay()

    session.applyUpdate(agentTextChunk('a'.repeat(600)))
    expect(session.messages.get()).toHaveLength(1)

    // 600 + 600 crosses the 1024 budget: this update and everything after it
    // must not land on the timeline.
    session.applyUpdate(agentTextChunk('b'.repeat(600)))
    session.applyUpdate(agentTextChunk('c'.repeat(50)))
    session.applyUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      title: 'Edit',
      kind: 'edit',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'd'.repeat(50) } }],
    })
    expect(session.messages.get()).toHaveLength(1)
    expect(session.toolCalls.get()).toHaveLength(0)
    expect(warn).toHaveBeenCalledOnce()
    expect(String(warn.mock.calls[0]?.[0])).toContain('1200')

    session.endHistoryReplay()
    const messages = session.messages.get()
    expect(messages).toHaveLength(2)
    expect(messages[1]?.role).toBe('agent')
    expect(messages[1]?.text).toBe(replayHistoryOverflowNotice())
  })

  it('keeps counting dropped updates without warning twice', () => {
    session = createSession()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    session.beginHistoryReplay()

    session.applyUpdate(agentTextChunk('a'.repeat(600)))
    session.applyUpdate(agentTextChunk('b'.repeat(600)))
    session.applyUpdate(agentTextChunk('c'.repeat(600)))
    expect(warn).toHaveBeenCalledOnce()
    expect(session.messages.get()).toHaveLength(1)
  })

  it('a replay within the budget keeps every update and adds no notice', () => {
    session = createSession()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    session.beginHistoryReplay()

    session.applyUpdate(agentTextChunk('a'.repeat(100)))
    session.applyUpdate(agentTextChunk('b'.repeat(100)))
    session.endHistoryReplay()

    expect(warn).not.toHaveBeenCalled()
    const messages = session.messages.get()
    expect(messages).toHaveLength(1)
    expect(messages[0]?.text).toBe('a'.repeat(100) + 'b'.repeat(100))
  })

  it('live (non-replay) updates are never budgeted', () => {
    session = createSession()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    session.applyUpdate(agentTextChunk('a'.repeat(TEST_BUDGET * 4)))
    expect(warn).not.toHaveBeenCalled()
    expect(session.messages.get()).toHaveLength(1)
    // No replay ever ran, so no notice either.
    session.endHistoryReplay()
    expect(session.messages.get()).toHaveLength(1)
  })
})
