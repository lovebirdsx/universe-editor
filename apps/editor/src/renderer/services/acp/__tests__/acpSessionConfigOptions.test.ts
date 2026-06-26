/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/acp/acpSessionConfigOptions.ts
 *
 *  Focus: the ConfigOptionStateMachine's three responsibilities in isolation —
 *    1) applyInitState seeds the observable from `session/new` payload
 *    2) ingestUpdate handles `config_option_update` notifications and filters
 *       echoes for in-flight pushes
 *    3) setConfigOption pushes via the connection, mirrors to history +
 *       defaults persistence, and clears the echo-suppression flag on finish.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { NoopTelemetryService } from '@universe-editor/platform'
import type {
  SessionConfigOption,
  SessionUpdate,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
} from '@agentclientprotocol/sdk'
import { ConfigOptionStateMachine } from '../acpSessionConfigOptions.js'
import type { IAcpClientConnection } from '../acpClientService.js'
import type { IAcpSessionHistoryService } from '../acpSessionHistory.js'
import type { IAcpAgentDefaultsService } from '../acpAgentDefaultsService.js'

function makeConfigOption(id: string, currentValue: string): SessionConfigOption {
  return {
    id,
    type: 'select',
    name: id,
    category: id === 'MODEL' ? 'model' : 'mode',
    currentValue,
    options: [
      { value: 'a', name: 'A' },
      { value: 'b', name: 'B' },
    ],
  }
}

function makeFakeConn(opts: {
  setSessionConfigOption?: (
    req: SetSessionConfigOptionRequest,
  ) => Promise<SetSessionConfigOptionResponse>
}): {
  conn: IAcpClientConnection
  calls: SetSessionConfigOptionRequest[]
  release: () => void
} {
  const calls: SetSessionConfigOptionRequest[] = []
  let resolve: (() => void) | undefined
  const conn: IAcpClientConnection = {
    conn: {
      setSessionConfigOption: async (req: SetSessionConfigOptionRequest) => {
        calls.push(req)
        // Park the call until the test releases it — lets tests observe the
        // in-flight echo-suppression state before the response lands.
        if (opts.setSessionConfigOption) {
          return opts.setSessionConfigOption(req)
        }
        await new Promise<void>((r) => {
          resolve = r
        })
        return {}
      },
    } as unknown as IAcpClientConnection['conn'],
    initializeResult: Promise.resolve({} as never),
    attachSession: () => {},
    dispose: () => {},
  }
  return {
    conn,
    calls,
    release: () => {
      resolve?.()
      resolve = undefined
    },
  }
}

function makeFakeHistory(): {
  history: IAcpSessionHistoryService
  calls: Array<{ sessionId: string; configId: string; value: string }>
} {
  const calls: Array<{ sessionId: string; configId: string; value: string }> = []
  const history = {
    setHistoryConfigOption: (sessionId: string, configId: string, value: string) =>
      calls.push({ sessionId, configId, value }),
  } as unknown as IAcpSessionHistoryService
  return { history, calls }
}

function makeFakeDefaults(): {
  defaults: IAcpAgentDefaultsService
  calls: Array<{ agentId: string; configId: string; value: string }>
} {
  const calls: Array<{ agentId: string; configId: string; value: string }> = []
  const defaults = {
    setDefault: (agentId: string, configId: string, value: string) =>
      calls.push({ agentId, configId, value }),
  } as unknown as IAcpAgentDefaultsService
  return { defaults, calls }
}

describe('ConfigOptionStateMachine', () => {
  it('applyInitState seeds the configOptions observable', () => {
    const { conn } = makeFakeConn({})
    const sm = new ConfigOptionStateMachine({
      getConn: () => conn,
      telemetry: new NoopTelemetryService(),
      sessionInfo: { localId: 'ag-1', agentId: 'a', getSessionId: () => 'ag-1' },
    })
    expect(sm.configOptions.get()).toEqual([])
    sm.applyInitState([makeConfigOption('MODEL', 'a')])
    expect(sm.configOptions.get()).toEqual([makeConfigOption('MODEL', 'a')])
  })

  it('ingestUpdate replaces configOptions when no push is in flight', () => {
    const { conn } = makeFakeConn({})
    const sm = new ConfigOptionStateMachine({
      getConn: () => conn,
      telemetry: new NoopTelemetryService(),
      sessionInfo: { localId: 'ag-1', agentId: 'a', getSessionId: () => 'ag-1' },
    })
    sm.applyInitState([makeConfigOption('MODEL', 'a')])
    const update: Extract<SessionUpdate, { sessionUpdate: 'config_option_update' }> = {
      sessionUpdate: 'config_option_update',
      configOptions: [makeConfigOption('MODEL', 'b')],
    }
    sm.ingestUpdate(update)
    expect(sm.configOptions.get()[0]?.currentValue).toBe('b')
  })

  it('ingestUpdate filters echoes for in-flight pushes', async () => {
    const fakeConn = makeFakeConn({})
    const sm = new ConfigOptionStateMachine({
      getConn: () => fakeConn.conn,
      telemetry: new NoopTelemetryService(),
      sessionInfo: { localId: 'ag-1', agentId: 'a', getSessionId: () => 'ag-1' },
    })
    sm.applyInitState([makeConfigOption('MODEL', 'a'), makeConfigOption('MODE', 'a')])
    // Start a push but don't resolve it — the configId stays in _pendingPushes.
    const push = sm.setConfigOption('MODEL', 'b')
    // The agent echoes the stale pre-change value AND an unrelated MODE change.
    const update: Extract<SessionUpdate, { sessionUpdate: 'config_option_update' }> = {
      sessionUpdate: 'config_option_update',
      configOptions: [makeConfigOption('MODEL', 'a'), makeConfigOption('MODE', 'b')],
    }
    sm.ingestUpdate(update)
    // MODEL stays at 'a' from initState — the echo for it was filtered. MODE
    // propagated because it wasn't in the pendingPushes set.
    const cur = sm.configOptions.get()
    expect(cur.find((o) => o.id === 'MODEL')?.currentValue).toBe('a')
    expect(cur.find((o) => o.id === 'MODE')?.currentValue).toBe('b')
    fakeConn.release()
    await push
  })

  it('setConfigOption pushes via conn and applies server response', async () => {
    const fakeConn = makeFakeConn({
      setSessionConfigOption: async () => ({
        configOptions: [makeConfigOption('MODEL', 'b')],
      }),
    })
    const sm = new ConfigOptionStateMachine({
      getConn: () => fakeConn.conn,
      telemetry: new NoopTelemetryService(),
      sessionInfo: { localId: 'ag-1', agentId: 'a', getSessionId: () => 'ag-1' },
    })
    sm.applyInitState([makeConfigOption('MODEL', 'a')])
    await sm.setConfigOption('MODEL', 'b')
    expect(fakeConn.calls).toEqual([{ sessionId: 'ag-1', configId: 'MODEL', value: 'b' }])
    expect(sm.configOptions.get()[0]?.currentValue).toBe('b')
  })

  it('setConfigOption mirrors to history when a history dep is provided', async () => {
    const fakeConn = makeFakeConn({ setSessionConfigOption: async () => ({ configOptions: [] }) })
    const fakeHistory = makeFakeHistory()
    const sm = new ConfigOptionStateMachine({
      getConn: () => fakeConn.conn,
      telemetry: new NoopTelemetryService(),
      sessionInfo: { localId: 'ag-1', agentId: 'a', getSessionId: () => 'ag-1' },
      history: fakeHistory.history,
    })
    await sm.setConfigOption('MODEL', 'b')
    expect(fakeHistory.calls).toEqual([{ sessionId: 'ag-1', configId: 'MODEL', value: 'b' }])
  })

  it('setConfigOption skips history mirror when no history dep is supplied', async () => {
    const fakeConn = makeFakeConn({ setSessionConfigOption: async () => ({ configOptions: [] }) })
    const fakeHistory = makeFakeHistory()
    const sm = new ConfigOptionStateMachine({
      getConn: () => fakeConn.conn,
      telemetry: new NoopTelemetryService(),
      sessionInfo: { localId: 'ag-1', agentId: 'a', getSessionId: () => 'ag-1' },
    })
    await sm.setConfigOption('MODEL', 'b')
    expect(fakeHistory.calls).toEqual([])
  })

  it('setConfigOption mirrors to agent defaults', async () => {
    const fakeConn = makeFakeConn({ setSessionConfigOption: async () => ({ configOptions: [] }) })
    const fakeDefaults = makeFakeDefaults()
    const sm = new ConfigOptionStateMachine({
      getConn: () => fakeConn.conn,
      telemetry: new NoopTelemetryService(),
      sessionInfo: { localId: 'ag-1', agentId: 'fake', getSessionId: () => 'ag-1' },
      defaults: fakeDefaults.defaults,
    })
    await sm.setConfigOption('MODEL', 'b')
    expect(fakeDefaults.calls).toEqual([{ agentId: 'fake', configId: 'MODEL', value: 'b' }])
  })

  it('setConfigOption clears pending push even when conn throws', async () => {
    const fakeConn = makeFakeConn({
      setSessionConfigOption: async () => {
        throw new Error('boom')
      },
    })
    const sm = new ConfigOptionStateMachine({
      getConn: () => fakeConn.conn,
      telemetry: new NoopTelemetryService(),
      sessionInfo: { localId: 'ag-1', agentId: 'a', getSessionId: () => 'ag-1' },
    })
    sm.applyInitState([makeConfigOption('MODEL', 'a')])
    await expect(sm.setConfigOption('MODEL', 'b')).rejects.toThrow('boom')
    // After the failed push, an unrelated echo for the SAME configId should now
    // propagate — the suppression flag was cleared by the finally block.
    sm.ingestUpdate({
      sessionUpdate: 'config_option_update',
      configOptions: [makeConfigOption('MODEL', 'c')],
    })
    expect(sm.configOptions.get()[0]?.currentValue).toBe('c')
  })
})
