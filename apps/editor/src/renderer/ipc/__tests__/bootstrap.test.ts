/*---------------------------------------------------------------------------------------------
 *  Tests for the renderer IPC bootstrap's decode attribution.
 *
 *  The platform delivers one observation per decoded inbound frame (see
 *  ipcDecodeObservation.test.ts for the seam itself). What is covered here is what the
 *  renderer does with it: a slow decode becomes one attributed perf phase (not a second
 *  sample next to the size-only one), a ≥4MiB frame gets a rate-limited warning with its
 *  shape and never its body, and small frames stay silent on both sinks.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultCodec, type IpcDecodeObservation } from '@universe-editor/platform'
import type { IpcBridge } from '../../../preload/index.js'
import {
  _resetPerfPhasesForTests,
  getRecordedPhases,
} from '../../services/performance/perfPhases.js'
import {
  admitLargeFrameLog,
  bindIpcFrameLog,
  createRendererIpcService,
  LARGE_FRAME_LOG_BYTES,
  recordInboundDecode,
  resetIpcDecodeDiagnosticsForTests,
} from '../bootstrap.js'

const MIB = 1024 * 1024

/** Stand-in for the preload bridge: keeps the frames it sent, delivers the ones it is given. */
function createFakeBridge(): {
  bridge: IpcBridge
  sent: Uint8Array[]
  deliver: (data: Uint8Array) => void
} {
  const sent: Uint8Array[] = []
  let listener: ((data: Uint8Array) => void) | undefined
  const bridge = {
    send: (data: Uint8Array) => {
      sent.push(data)
    },
    onMessage: (cb: (data: Uint8Array) => void) => {
      listener = cb
      return () => {
        listener = undefined
      }
    },
  } as unknown as IpcBridge
  return { bridge, sent, deliver: (data) => listener?.(data) }
}

const observation = (over: Partial<IpcDecodeObservation> = {}): IpcDecodeObservation => ({
  type: 'response',
  channel: 'fileSearch',
  name: 'findFiles',
  id: 42,
  bytes: 8 * MIB,
  startTime: 1000,
  durationMs: 1,
  ...over,
})

let warn: ReturnType<typeof vi.fn>
let error: ReturnType<typeof vi.fn>

beforeEach(() => {
  warn = vi.fn()
  error = vi.fn()
  bindIpcFrameLog({ warn, error })
  resetIpcDecodeDiagnosticsForTests()
  _resetPerfPhasesForTests()
})

describe('renderer decode attribution over a real request/response chain', () => {
  it('names the request a large reply answers, without logging its body', async () => {
    const { bridge, sent, deliver } = createFakeBridge()
    const ipc = createRendererIpcService(bridge)
    const marker = 'TOP_SECRET_BODY_MARKER'
    const payload = { files: [`${marker}${'x'.repeat(LARGE_FRAME_LOG_BYTES)}`] }

    const pending = ipc.getChannel('fileSearch').call('findFiles', { include: '**/*.ts' })
    const request = defaultCodec.decode(sent[0]!) as { type: string; id: number }
    expect(request.type).toBe('request')
    deliver(defaultCodec.encode({ type: 'response', id: request.id, data: payload }))
    await expect(pending).resolves.toEqual(payload)

    expect(warn).toHaveBeenCalledTimes(1)
    const line = warn.mock.calls[0]?.[0] as string
    // Direction, frame kind, channel, method, id, size — and the decode cost, which is
    // what makes a fast-but-huge and a slow-but-small frame tell themselves apart.
    expect(line).toContain('large inbound ipc frame')
    expect(line).toContain('(response fileSearch.findFiles #1)')
    expect(line).toContain('decode ')
    expect(line).not.toContain(marker)
    expect(error).not.toHaveBeenCalled()

    ipc.dispose()
  })

  it('stays silent on both sinks for a small frame that decodes fast', async () => {
    const { bridge, sent, deliver } = createFakeBridge()
    const ipc = createRendererIpcService(bridge)

    const pending = ipc.getChannel('math').call('add', 1)
    const request = defaultCodec.decode(sent[0]!) as { id: number }
    deliver(defaultCodec.encode({ type: 'response', id: request.id, data: 2 }))
    await expect(pending).resolves.toBe(2)

    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
    expect(getRecordedPhases().filter((p) => p.name.startsWith('ipc.decode'))).toHaveLength(0)

    ipc.dispose()
  })
})

describe('slow decode phase', () => {
  it('records one attributed sample, carrying channel, method, kind, id and size', () => {
    recordInboundDecode(observation({ durationMs: 615, bytes: 5 * MIB }))

    const phases = getRecordedPhases()
    // Exactly one: the size-only sample this replaces used to be recorded from the
    // decode wrapper, and both would now describe the same decode.
    expect(phases).toHaveLength(1)
    expect(phases[0]).toMatchObject({
      name: 'ipc.decode (response fileSearch.findFiles #42, 5.0MB)',
      startTime: 1000,
      duration: 615,
    })
  })

  it('records nothing below the slow threshold, at any size', () => {
    recordInboundDecode(observation({ durationMs: 4.9, bytes: 5 * MIB }))
    expect(getRecordedPhases().filter((p) => p.name.startsWith('ipc.decode'))).toHaveLength(0)
  })
})

describe('large frame log', () => {
  it('warns for a frame at the line even when it decoded instantly', () => {
    recordInboundDecode(observation({ bytes: LARGE_FRAME_LOG_BYTES, durationMs: 0.2 }))
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('decode 0.2ms')
  })

  it('stays under the line for the frame just below it', () => {
    recordInboundDecode(observation({ bytes: LARGE_FRAME_LOG_BYTES - 1 }))
    expect(warn).not.toHaveBeenCalled()
  })

  it('folds repeats of one target into a single line per window', () => {
    for (let id = 1; id <= 30; id++) recordInboundDecode(observation({ id }))
    expect(warn).toHaveBeenCalledTimes(1)
    // The first admitted occurrence is the one that names the target; the rest only
    // prove the limiter held.
    expect(String(warn.mock.calls[0]?.[0])).toContain('#1')

    // A different target is not folded away by another target's window.
    recordInboundDecode(observation({ type: 'request', name: 'readFile', id: 31 }))
    expect(warn).toHaveBeenCalledTimes(2)
  })
})

describe('large frame log limiter', () => {
  it('admits again once the window has passed', () => {
    expect(admitLargeFrameLog('k', 1000)).toBe(true)
    expect(admitLargeFrameLog('k', 1000 + 9_999)).toBe(false)
    expect(admitLargeFrameLog('k', 1000 + 10_000)).toBe(true)
  })

  it('keeps the tracked targets bounded', () => {
    for (let i = 0; i < 100; i++) admitLargeFrameLog(`k${i}`, 1000)
    // The cap evicted the oldest targets — if the map grew without bound, this key would
    // still be inside its window and the admit would be refused.
    expect(admitLargeFrameLog('k0', 1000)).toBe(true)
  })
})
