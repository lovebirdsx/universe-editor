import { afterEach, describe, expect, it } from 'vitest'
import {
  AGENT_SESSIONS_PROTOCOL,
  emptyAgentSessionsSnapshot,
  sendAgentSessionsPayload,
  serializeAgentSessionsSnapshot,
  startAgentSessionsResponseServer,
  type AgentSessionsResponseServer,
} from '../agentSessionsCli.js'

describe('agentSessionsCli', () => {
  const servers: AgentSessionsResponseServer[] = []

  afterEach(() => {
    for (const server of servers.splice(0)) server.dispose()
  })

  it('serializes the snapshot with a protocol version', () => {
    const payload = serializeAgentSessionsSnapshot(emptyAgentSessionsSnapshot())
    expect(JSON.parse(payload)).toEqual({
      protocol: AGENT_SESSIONS_PROTOCOL,
      windowCount: 0,
      failedWindows: [],
      sessions: [],
    })
    expect(payload.endsWith('\n')).toBe(true)
  })

  it('round-trips a payload through the local response pipe', async () => {
    const server = startAgentSessionsResponseServer()
    servers.push(server)

    const sent = await sendAgentSessionsPayload(server.pipeName, '{"ok":true}\n')

    expect(sent).toBe(true)
    await expect(server.response).resolves.toBe('{"ok":true}\n')
  })

  it('rejects an unusable pipe name without hanging', async () => {
    await expect(sendAgentSessionsPayload(undefined, '{}')).resolves.toBe(false)
    await expect(sendAgentSessionsPayload('', '{}')).resolves.toBe(false)
  })
})
