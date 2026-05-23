/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/acp/testing/inMemoryAcpPair.ts
 *
 *  Wires a real `ClientSideConnection` to a real `AgentSideConnection` via the
 *  pair and verifies a request/response round-trip plus a server-initiated
 *  notification arrive intact.
 *--------------------------------------------------------------------------------------------*/

import {
  AgentSideConnection,
  ClientSideConnection,
  type Agent,
  type Client,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type CancelNotification,
  type InitializeRequest,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'
import { createInMemoryAcpPair } from '../testing/inMemoryAcpPair.js'

class StubAgent implements Agent {
  initializeCalls: InitializeRequest[] = []
  newSessionCalls: NewSessionRequest[] = []
  promptCalls: PromptRequest[] = []
  cancelCalls: CancelNotification[] = []
  /** Hook that lets a test trigger a sessionUpdate from the agent side. */
  triggerUpdate?: (params: SessionNotification) => Promise<void>
  /** Hook that lets a test trigger a readTextFile from the agent side. */
  triggerReadFile?: (params: ReadTextFileRequest) => Promise<ReadTextFileResponse>

  initialize(params: InitializeRequest): Promise<InitializeResponse> {
    this.initializeCalls.push(params)
    return Promise.resolve({
      protocolVersion: 1,
      agentCapabilities: { loadSession: false, promptCapabilities: {} },
      authMethods: [],
    } as unknown as InitializeResponse)
  }

  newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    this.newSessionCalls.push(params)
    return Promise.resolve({ sessionId: 'sess-1' } as unknown as NewSessionResponse)
  }

  prompt(params: PromptRequest): Promise<PromptResponse> {
    this.promptCalls.push(params)
    return Promise.resolve({ stopReason: 'end_turn' } as unknown as PromptResponse)
  }

  cancel(params: CancelNotification): Promise<void> {
    this.cancelCalls.push(params)
    return Promise.resolve()
  }

  authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse | void> {
    return Promise.resolve()
  }
}

class StubClient implements Client {
  sessionUpdates: SessionNotification[] = []
  permissionCalls: RequestPermissionRequest[] = []
  readFileCalls: ReadTextFileRequest[] = []
  readFileResponse: ReadTextFileResponse = { content: 'stub' } as unknown as ReadTextFileResponse

  sessionUpdate(params: SessionNotification): Promise<void> {
    this.sessionUpdates.push(params)
    return Promise.resolve()
  }

  requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    this.permissionCalls.push(params)
    return Promise.resolve({
      outcome: { outcome: 'cancelled' },
    } as unknown as RequestPermissionResponse)
  }

  readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    this.readFileCalls.push(params)
    return Promise.resolve(this.readFileResponse)
  }
}

describe('createInMemoryAcpPair', () => {
  it('round-trips a client-initiated request through the SDK connection', async () => {
    const pair = createInMemoryAcpPair()
    const agent = new StubAgent()
    const client = new StubClient()

    const _agentConn = new AgentSideConnection(() => agent, pair.agentStream)
    const clientConn = new ClientSideConnection(() => client, pair.clientStream)

    const resp = await clientConn.initialize({ protocolVersion: 1 } as InitializeRequest)
    expect(resp).toEqual({
      protocolVersion: 1,
      agentCapabilities: { loadSession: false, promptCapabilities: {} },
      authMethods: [],
    })
    expect(agent.initializeCalls).toHaveLength(1)
    void _agentConn
  })

  it('delivers agent-initiated sessionUpdate notifications to the client', async () => {
    const pair = createInMemoryAcpPair()
    const agent = new StubAgent()
    const client = new StubClient()

    const agentConn = new AgentSideConnection(() => agent, pair.agentStream)
    const _clientConn = new ClientSideConnection(() => client, pair.clientStream)

    const note = {
      sessionId: 'sess-1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } },
    } as unknown as SessionNotification
    await agentConn.sessionUpdate(note)
    // notifications have no response, but the message has to flush through the
    // transform → wait a microtask.
    await Promise.resolve()
    await Promise.resolve()

    expect(client.sessionUpdates).toHaveLength(1)
    expect(client.sessionUpdates[0]).toEqual(note)
    void _clientConn
  })

  it('delivers agent-initiated readTextFile requests and routes the response back', async () => {
    const pair = createInMemoryAcpPair()
    const agent = new StubAgent()
    const client = new StubClient()
    client.readFileResponse = { content: 'hello world' } as unknown as ReadTextFileResponse

    const agentConn = new AgentSideConnection(() => agent, pair.agentStream)
    const _clientConn = new ClientSideConnection(() => client, pair.clientStream)

    const reqParams = { sessionId: 'sess-1', path: '/tmp/x.txt' } as ReadTextFileRequest
    const result = await agentConn.readTextFile(reqParams)
    expect(result).toEqual({ content: 'hello world' })
    expect(client.readFileCalls).toEqual([reqParams])
    void _clientConn
  })
})
