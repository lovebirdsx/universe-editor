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
  SessionConfigOptionCategory,
  SessionUpdate,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
} from '@agentclientprotocol/sdk'
import { ConfigOptionStateMachine } from '../acpSessionConfigOptions.js'
import type { IAcpClientConnection } from '../../acpClientService.js'
import type { IAcpSessionHistoryService } from '../acpSessionHistory.js'
import type { IAcpAgentDefaultsService } from '../acpAgentDefaultsService.js'

function makeConfigOption(
  id: string,
  currentValue: string,
  category: SessionConfigOptionCategory = id === 'MODEL' ? 'model' : 'mode',
): SessionConfigOption {
  return {
    id,
    type: 'select',
    name: id,
    category,
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
  calls: Array<{ sessionId: string; configId: string; value: string; label?: string }>
} {
  const calls: Array<{ sessionId: string; configId: string; value: string; label?: string }> = []
  const history = {
    setHistoryConfigOption: (sessionId: string, configId: string, value: string, label?: string) =>
      calls.push({ sessionId, configId, value, ...(label !== undefined ? { label } : {}) }),
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

  it('ingestUpdate applies only the declared options when _meta carries changedConfigIds', () => {
    const { conn } = makeFakeConn({})
    const sm = new ConfigOptionStateMachine({
      getConn: () => conn,
      telemetry: new NoopTelemetryService(),
      sessionInfo: { localId: 'ag-1', agentId: 'a', getSessionId: () => 'ag-1' },
    })
    // Resumed session: the restored values are MODEL='a', MODE='b'.
    sm.applyInitState([makeConfigOption('MODEL', 'a'), makeConfigOption('MODE', 'b')])
    // The agent's resume-time model reconciliation corrected only MODEL but
    // broadcasts the whole bag — where MODE is still the recreated session's
    // seed. The declaration must scope the update to MODEL.
    sm.ingestUpdate({
      sessionUpdate: 'config_option_update',
      configOptions: [makeConfigOption('MODEL', 'b'), makeConfigOption('MODE', 'a')],
      _meta: { 'universe-editor/changedConfigIds': ['MODEL'] },
    })
    const cur = sm.configOptions.get()
    expect(cur.find((o) => o.id === 'MODEL')?.currentValue).toBe('b')
    expect(cur.find((o) => o.id === 'MODE')?.currentValue).toBe('b')
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
    // The push now applies 'b' optimistically before the RPC resolves.
    const push = sm.setConfigOption('MODEL', 'b')
    // The agent echoes the stale pre-change value AND an unrelated MODE change.
    const update: Extract<SessionUpdate, { sessionUpdate: 'config_option_update' }> = {
      sessionUpdate: 'config_option_update',
      configOptions: [makeConfigOption('MODEL', 'a'), makeConfigOption('MODE', 'b')],
    }
    sm.ingestUpdate(update)
    // MODEL stays at the optimistic 'b' — the echo restoring it to 'a' was
    // filtered. MODE propagated because it wasn't in the pendingPushes set.
    const cur = sm.configOptions.get()
    expect(cur.find((o) => o.id === 'MODEL')?.currentValue).toBe('b')
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

  it('setConfigOption applies locally + persists default when not connected (optimistic)', async () => {
    const fakeDefaults = makeFakeDefaults()
    const sm = new ConfigOptionStateMachine({
      // No live connection — simulates the optimistic placeholder window before
      // attachConnection lands.
      getConn: () => undefined,
      telemetry: new NoopTelemetryService(),
      sessionInfo: { localId: 'local-1', agentId: 'fake', getSessionId: () => undefined },
      defaults: fakeDefaults.defaults,
    })
    sm.applyInitState([makeConfigOption('MODEL', 'a')])
    await sm.setConfigOption('MODEL', 'b')
    // Local observable flips immediately so the UI reflects the pick.
    expect(sm.configOptions.get()[0]?.currentValue).toBe('b')
    // The choice is persisted as the per-agent default so the post-connect
    // push-back picks it up.
    expect(fakeDefaults.calls).toEqual([{ agentId: 'fake', configId: 'MODEL', value: 'b' }])
  })

  it('suppressDefaults skips the defaults write but keeps history + RPC (connected)', async () => {
    const fakeConn = makeFakeConn({ setSessionConfigOption: async () => ({ configOptions: [] }) })
    const fakeDefaults = makeFakeDefaults()
    const fakeHistory = makeFakeHistory()
    const sm = new ConfigOptionStateMachine({
      getConn: () => fakeConn.conn,
      telemetry: new NoopTelemetryService(),
      sessionInfo: { localId: 'ag-1', agentId: 'fake', getSessionId: () => 'ag-1' },
      history: fakeHistory.history,
      defaults: fakeDefaults.defaults,
      suppressDefaults: true,
    })
    await sm.setConfigOption('MODEL', 'b')
    // The RPC still goes out and per-session history still records the pick…
    expect(fakeConn.calls).toEqual([{ sessionId: 'ag-1', configId: 'MODEL', value: 'b' }])
    expect(fakeHistory.calls).toEqual([{ sessionId: 'ag-1', configId: 'MODEL', value: 'b' }])
    // …but the per-agent defaults are NOT touched (AI Fix isolation).
    expect(fakeDefaults.calls).toEqual([])
  })

  it('suppressDefaults skips the defaults write on the optimistic (pre-connect) path', async () => {
    const fakeDefaults = makeFakeDefaults()
    const sm = new ConfigOptionStateMachine({
      getConn: () => undefined,
      telemetry: new NoopTelemetryService(),
      sessionInfo: { localId: 'local-1', agentId: 'fake', getSessionId: () => undefined },
      defaults: fakeDefaults.defaults,
      suppressDefaults: true,
    })
    sm.applyInitState([makeConfigOption('MODEL', 'a')])
    await sm.setConfigOption('MODEL', 'b')
    expect(sm.configOptions.get()[0]?.currentValue).toBe('b')
    expect(fakeDefaults.calls).toEqual([])
  })

  it('flushPendingPushes resolves only after every pending push has been sent to the agent', async () => {
    const fakeConn = makeFakeConn({
      setSessionConfigOption: async (req) => ({
        configOptions: [makeConfigOption(String(req.configId), String(req.value))],
      }),
    })
    const sm = new ConfigOptionStateMachine({
      getConn: () => fakeConn.conn,
      telemetry: new NoopTelemetryService(),
      sessionInfo: { localId: 'ag-1', agentId: 'a', getSessionId: () => 'ag-1' },
    })
    // A `plan` mode was picked while connecting: desired differs from the bag's
    // server value, so reconcile queues it in _needsPush.
    sm.setDesired({ MODE: 'b' })
    sm.applyInitState([makeConfigOption('MODE', 'a')])
    // attachConnection awaits this before dispatching queued prompts. When it
    // resolves the RPC must already have been issued — otherwise a queued prompt
    // races ahead of the mode push and the agent runs under the default mode.
    await sm.flushPendingPushes()
    expect(fakeConn.calls).toEqual([{ sessionId: 'ag-1', configId: 'MODE', value: 'b' }])
    expect(sm.configOptions.get()[0]?.currentValue).toBe('b')
  })

  it('a re-entrant flushPendingPushes awaits the sequence already running', async () => {
    const fakeConn = makeFakeConn({
      setSessionConfigOption: async (req) => ({
        configOptions: [makeConfigOption(String(req.configId), String(req.value))],
      }),
    })
    const sm = new ConfigOptionStateMachine({
      getConn: () => fakeConn.conn,
      telemetry: new NoopTelemetryService(),
      sessionInfo: { localId: 'ag-1', agentId: 'a', getSessionId: () => 'ag-1' },
    })
    sm.setDesired({ MODE: 'b' })
    // applyInitState kicks off a flush internally; attachConnection's own call
    // must join that in-flight sequence rather than resolve immediately past it.
    sm.applyInitState([makeConfigOption('MODE', 'a')])
    await sm.flushPendingPushes()
    expect(fakeConn.calls).toEqual([{ sessionId: 'ag-1', configId: 'MODE', value: 'b' }])
  })

  it('ingestUpdate mirrors an agent-initiated mode change to history', () => {
    const fakeConn = makeFakeConn({})
    const fakeHistory = makeFakeHistory()
    const fakeDefaults = makeFakeDefaults()
    const sm = new ConfigOptionStateMachine({
      getConn: () => fakeConn.conn,
      telemetry: new NoopTelemetryService(),
      sessionInfo: { localId: 'ag-1', agentId: 'fake', getSessionId: () => 'ag-1' },
      history: fakeHistory.history,
      defaults: fakeDefaults.defaults,
    })
    sm.applyInitState([makeConfigOption('MODE', 'a')])
    // Plan approved: the agent switches itself to bypass and broadcasts it.
    sm.ingestUpdate({
      sessionUpdate: 'config_option_update',
      configOptions: [makeConfigOption('MODE', 'b')],
    })
    expect(sm.configOptions.get()[0]?.currentValue).toBe('b')
    expect(fakeHistory.calls).toEqual([
      { sessionId: 'ag-1', configId: 'MODE', value: 'b', label: 'B' },
    ])
    // An agent drive is not a user choice, so per-agent defaults stay untouched.
    expect(fakeDefaults.calls).toEqual([])
  })

  it('ingestUpdate mirrors collaboration_mode (codex) the same way', () => {
    const fakeConn = makeFakeConn({})
    const fakeHistory = makeFakeHistory()
    const sm = new ConfigOptionStateMachine({
      getConn: () => fakeConn.conn,
      telemetry: new NoopTelemetryService(),
      sessionInfo: { localId: 'ag-1', agentId: 'codex', getSessionId: () => 'ag-1' },
      history: fakeHistory.history,
    })
    sm.applyInitState([makeConfigOption('collaboration_mode', 'a', 'collaboration_mode')])
    sm.ingestUpdate({
      sessionUpdate: 'config_option_update',
      configOptions: [makeConfigOption('collaboration_mode', 'b', 'collaboration_mode')],
    })
    expect(fakeHistory.calls).toEqual([
      { sessionId: 'ag-1', configId: 'collaboration_mode', value: 'b', label: 'B' },
    ])
  })

  it('ingestUpdate does not mirror non-mode options', () => {
    const fakeConn = makeFakeConn({})
    const fakeHistory = makeFakeHistory()
    const sm = new ConfigOptionStateMachine({
      getConn: () => fakeConn.conn,
      telemetry: new NoopTelemetryService(),
      sessionInfo: { localId: 'ag-1', agentId: 'a', getSessionId: () => 'ag-1' },
      history: fakeHistory.history,
    })
    sm.applyInitState([makeConfigOption('MODEL', 'a')])
    sm.ingestUpdate({
      sessionUpdate: 'config_option_update',
      configOptions: [makeConfigOption('MODEL', 'b')],
    })
    expect(fakeHistory.calls).toEqual([])
  })

  it('ingestUpdate does not mirror while canPersistAgentChanges is false (replay / read-only)', () => {
    const fakeConn = makeFakeConn({})
    const fakeHistory = makeFakeHistory()
    const sm = new ConfigOptionStateMachine({
      getConn: () => fakeConn.conn,
      telemetry: new NoopTelemetryService(),
      sessionInfo: { localId: 'ag-1', agentId: 'a', getSessionId: () => 'ag-1' },
      history: fakeHistory.history,
      canPersistAgentChanges: () => false,
    })
    sm.applyInitState([makeConfigOption('MODE', 'a')])
    sm.ingestUpdate({
      sessionUpdate: 'config_option_update',
      configOptions: [makeConfigOption('MODE', 'b')],
    })
    // The display still follows the notification; only persistence is skipped.
    expect(sm.configOptions.get()[0]?.currentValue).toBe('b')
    expect(fakeHistory.calls).toEqual([])
  })

  it('ingestUpdate ignores a still-provisional mode option (optimistic seed echo)', () => {
    const fakeConn = makeFakeConn({})
    const fakeHistory = makeFakeHistory()
    const sm = new ConfigOptionStateMachine({
      getConn: () => fakeConn.conn,
      telemetry: new NoopTelemetryService(),
      sessionInfo: { localId: 'ag-1', agentId: 'a', getSessionId: () => 'ag-1' },
      history: fakeHistory.history,
    })
    sm.seedConfigOptions([makeConfigOption('MODE', 'a')])
    sm.ingestUpdate({
      sessionUpdate: 'config_option_update',
      configOptions: [makeConfigOption('MODE', 'b')],
    })
    expect(fakeHistory.calls).toEqual([])
  })

  it('ingestUpdate does not mirror a suppressed echo of an in-flight user push', async () => {
    const fakeConn = makeFakeConn({})
    const fakeHistory = makeFakeHistory()
    const sm = new ConfigOptionStateMachine({
      getConn: () => fakeConn.conn,
      telemetry: new NoopTelemetryService(),
      sessionInfo: { localId: 'ag-1', agentId: 'a', getSessionId: () => 'ag-1' },
      history: fakeHistory.history,
    })
    sm.applyInitState([makeConfigOption('MODE', 'a')])
    const push = sm.setConfigOption('MODE', 'b')
    sm.ingestUpdate({
      sessionUpdate: 'config_option_update',
      configOptions: [makeConfigOption('MODE', 'a')],
    })
    expect(fakeHistory.calls).toEqual([])
    fakeConn.release()
    await push
    // Only the user's own push persisted the value.
    expect(fakeHistory.calls).toEqual([
      { sessionId: 'ag-1', configId: 'MODE', value: 'b', label: 'B' },
    ])
  })

  it('keeps a pending push when an undeclared full bag carries a different mode', async () => {
    const fakeConn = makeFakeConn({
      setSessionConfigOption: async (req) => ({
        configOptions: [makeConfigOption(String(req.configId), String(req.value))],
      }),
    })
    const fakeHistory = makeFakeHistory()
    const sm = new ConfigOptionStateMachine({
      getConn: () => fakeConn.conn,
      telemetry: new NoopTelemetryService(),
      sessionInfo: { localId: 'ag-1', agentId: 'a', getSessionId: () => 'ag-1' },
      history: fakeHistory.history,
    })
    sm.setDesired({ MODE: 'b' })
    sm.applyInitState([makeConfigOption('MODE', 'a')])
    // A stale recreated-session seed still says 'a'; the pending push must survive it.
    sm.ingestUpdate({
      sessionUpdate: 'config_option_update',
      configOptions: [makeConfigOption('MODE', 'a')],
    })
    expect(fakeHistory.calls).toEqual([])
    await sm.flushPendingPushes()
    expect(fakeConn.calls).toEqual([{ sessionId: 'ag-1', configId: 'MODE', value: 'b' }])
    // The pending push is still the final writer, so the stale bag cannot stick.
    expect(sm.configOptions.get()[0]?.currentValue).toBe('b')
  })

  it('mirrors a declared mode change even when a different push is pending', async () => {
    const fakeConn = makeFakeConn({
      setSessionConfigOption: async (req) => ({
        configOptions: [makeConfigOption(String(req.configId), String(req.value))],
      }),
    })
    const fakeHistory = makeFakeHistory()
    const sm = new ConfigOptionStateMachine({
      getConn: () => fakeConn.conn,
      telemetry: new NoopTelemetryService(),
      sessionInfo: { localId: 'ag-1', agentId: 'a', getSessionId: () => 'ag-1' },
      history: fakeHistory.history,
    })
    sm.setDesired({ MODE: 'b' })
    sm.applyInitState([makeConfigOption('MODE', 'a')])
    // The agent explicitly declares MODE as changed: this supersedes the pending push.
    sm.ingestUpdate({
      sessionUpdate: 'config_option_update',
      configOptions: [makeConfigOption('MODE', 'a')],
      _meta: { 'universe-editor/changedConfigIds': ['MODE'] },
    })
    expect(fakeHistory.calls).toEqual([
      { sessionId: 'ag-1', configId: 'MODE', value: 'a', label: 'A' },
    ])
    await sm.flushPendingPushes()
    expect(fakeConn.calls).toEqual([])
  })

  it('adopts the mirrored mode as desired so a later init bag does not push the old value', async () => {
    const fakeConn = makeFakeConn({
      setSessionConfigOption: async (req) => ({
        configOptions: [makeConfigOption(String(req.configId), String(req.value))],
      }),
    })
    const sm = new ConfigOptionStateMachine({
      getConn: () => fakeConn.conn,
      telemetry: new NoopTelemetryService(),
      sessionInfo: { localId: 'ag-1', agentId: 'a', getSessionId: () => 'ag-1' },
    })
    sm.applyInitState([makeConfigOption('MODE', 'a')])
    sm.ingestUpdate({
      sessionUpdate: 'config_option_update',
      configOptions: [makeConfigOption('MODE', 'b')],
    })
    // A resume/reattach advertises the stale server value again; the mirrored
    // value is now the desired one and must be pushed back.
    sm.applyInitState([makeConfigOption('MODE', 'a')])
    expect(sm.configOptions.get()[0]?.currentValue).toBe('b')
    await sm.flushPendingPushes()
    expect(fakeConn.calls).toEqual([{ sessionId: 'ag-1', configId: 'MODE', value: 'b' }])
  })

  it('flushPendingPushes does not write per-agent defaults', async () => {
    const fakeConn = makeFakeConn({
      setSessionConfigOption: async (req) => ({
        configOptions: [makeConfigOption(String(req.configId), String(req.value))],
      }),
    })
    const fakeDefaults = makeFakeDefaults()
    const sm = new ConfigOptionStateMachine({
      getConn: () => fakeConn.conn,
      telemetry: new NoopTelemetryService(),
      sessionInfo: { localId: 'ag-1', agentId: 'fake', getSessionId: () => 'ag-1' },
      defaults: fakeDefaults.defaults,
    })
    sm.setDesired({ MODE: 'b' })
    sm.applyInitState([makeConfigOption('MODE', 'a')])
    await sm.flushPendingPushes()
    expect(fakeConn.calls).toEqual([{ sessionId: 'ag-1', configId: 'MODE', value: 'b' }])
    // Restoring a session value must not become the default for future sessions.
    expect(fakeDefaults.calls).toEqual([])
  })

  it('suppressDefaults keeps a side-task mode pin when the agent changes it', () => {
    const fakeConn = makeFakeConn({})
    const fakeHistory = makeFakeHistory()
    const fakeDefaults = makeFakeDefaults()
    const sm = new ConfigOptionStateMachine({
      getConn: () => fakeConn.conn,
      telemetry: new NoopTelemetryService(),
      sessionInfo: { localId: 'side-1', agentId: 'claude-code', getSessionId: () => 'side-1' },
      history: fakeHistory.history,
      defaults: fakeDefaults.defaults,
      suppressDefaults: true,
    })
    sm.applyInitState([makeConfigOption('MODE', 'b')])
    sm.ingestUpdate({
      sessionUpdate: 'config_option_update',
      configOptions: [makeConfigOption('MODE', 'a')],
    })
    // The history mode is an editor pin (dontAsk / read-only); the agent must
    // not overwrite it, and no per-agent default is written either.
    expect(fakeHistory.calls).toEqual([])
    expect(fakeDefaults.calls).toEqual([])
  })
})
