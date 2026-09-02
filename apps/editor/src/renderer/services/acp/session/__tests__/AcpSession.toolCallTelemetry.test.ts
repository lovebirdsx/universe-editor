/*---------------------------------------------------------------------------------------------
 *  `acp.tool_call_failed` classification. A tool the agent ran that exited
 *  non-zero is the agent's business outcome, not an editor fault — reporting it
 *  as an error drowned every genuine renderer error out of the top-fingerprints
 *  view (96 of the top 96 in one user's diagnostics). Replays must not report at
 *  all: session/load re-emits every historical failure, so counting them
 *  multiplied one incident by the number of times its session was reopened.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ITelemetryData, ITelemetryService } from '@universe-editor/platform'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { AcpSession } from '../acpSession.js'
import { StubSessionChangeTracker } from './stubSessionChangeTracker.js'

interface RecordedEvent {
  readonly name: string
  readonly data: ITelemetryData | undefined
}

class RecordingTelemetryService implements ITelemetryService {
  declare readonly _serviceBrand: undefined
  readonly logged: RecordedEvent[] = []
  readonly errors: RecordedEvent[] = []

  publicLog(name: string, data?: ITelemetryData): void {
    this.logged.push({ name, data })
  }
  publicLogMeasure(): void {}
  publicLogError(name: string, data?: ITelemetryData): void {
    this.errors.push({ name, data })
  }
  getTelemetryInfo(): Promise<{ sessionId: string; machineId: string }> {
    return Promise.resolve({ sessionId: 'test', machineId: 'test' })
  }
}

function createSession(telemetry: ITelemetryService): AcpSession {
  return new AcpSession(
    's1',
    'claude-code',
    't',
    telemetry,
    undefined,
    'default',
    undefined,
    undefined,
    new StubSessionChangeTracker(),
    undefined,
    false,
  )
}

function startBash(toolName?: string): SessionUpdate {
  return {
    sessionUpdate: 'tool_call',
    toolCallId: 'tc-1',
    title: 'Bash',
    kind: 'execute',
    status: 'in_progress',
    content: [],
    ...(toolName !== undefined ? { _meta: { claudeCode: { toolName } } } : {}),
  }
}

function failBash(toolName?: string): SessionUpdate {
  return {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tc-1',
    status: 'failed',
    ...(toolName !== undefined ? { _meta: { claudeCode: { toolName } } } : {}),
  }
}

describe('AcpSession — tool_call_failed telemetry', () => {
  let session: AcpSession | undefined

  afterEach(() => {
    session?.dispose()
    session = undefined
    vi.restoreAllMocks()
  })

  it('reports a live failure as usage, never as an error', () => {
    const telemetry = new RecordingTelemetryService()
    session = createSession(telemetry)

    session.applyUpdate(startBash('Bash'))
    session.applyUpdate(failBash('Bash'))

    expect(telemetry.errors).toEqual([])
    const failed = telemetry.logged.filter((e) => e.name === 'acp.tool_call_failed')
    expect(failed).toHaveLength(1)
    expect(failed[0]?.data).toMatchObject({
      sessionId: 's1',
      agentId: 'claude-code',
      kind: 'execute',
      toolName: 'Bash',
    })
  })

  it('omits toolName when the agent does not report one', () => {
    const telemetry = new RecordingTelemetryService()
    session = createSession(telemetry)

    session.applyUpdate(startBash())
    session.applyUpdate(failBash())

    const failed = telemetry.logged.find((e) => e.name === 'acp.tool_call_failed')
    expect(failed?.data).not.toHaveProperty('toolName')
    expect(failed?.data).toMatchObject({ kind: 'execute' })
  })

  it('collapses an MCP tool name to its server to bound dimension cardinality', () => {
    const telemetry = new RecordingTelemetryService()
    session = createSession(telemetry)

    session.applyUpdate(startBash('mcp__sqlite__query'))
    session.applyUpdate(failBash('mcp__sqlite__query'))

    const failed = telemetry.logged.find((e) => e.name === 'acp.tool_call_failed')
    expect(failed?.data).toMatchObject({ toolName: 'mcp__sqlite' })
  })

  it('does not report failures replayed by session/load', () => {
    const telemetry = new RecordingTelemetryService()
    session = createSession(telemetry)

    session.beginHistoryReplay()
    session.applyUpdate(startBash('Bash'))
    session.applyUpdate(failBash('Bash'))
    session.endHistoryReplay()

    expect(telemetry.errors).toEqual([])
    expect(telemetry.logged.filter((e) => e.name === 'acp.tool_call_failed')).toEqual([])
  })
})
