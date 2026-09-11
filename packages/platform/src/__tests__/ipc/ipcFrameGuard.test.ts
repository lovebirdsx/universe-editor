/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, beforeEach } from 'vitest'
import {
  IPC_FRAME_MAX_BYTES,
  IPC_FRAME_TOO_LARGE_CODE,
  IPC_FRAME_WARN_BYTES,
  IpcFrameTooLargeError,
  assertIpcFrameWithinLimit,
  classifyIpcFrame,
  formatIpcFrameAlert,
  formatIpcFrames,
  ipcFrameStats,
  reportIpcFrame,
  resetIpcFrameDiagnosticsForTests,
  setIpcFrameDiagnostics,
  snapshotIpcFrames,
  type IpcFrameOversizedInfo,
  type IpcFrameSizeInfo,
} from '../../ipc/ipcFrameGuard.js'

const report = (
  bytes: number,
  over: Partial<{
    direction: 'in' | 'out'
    type: string
    channel: string
    name: string
    id: number
  }> = {},
): void =>
  reportIpcFrame(
    over.direction ?? 'out',
    bytes,
    over.type ?? 'response',
    over.channel ?? 'fileSearch',
    over.name ?? 'search',
    over.id ?? 0,
  )

beforeEach(() => resetIpcFrameDiagnosticsForTests())

describe('classifyIpcFrame', () => {
  it('treats the warn line as inclusive and the max line as still deliverable', () => {
    expect(classifyIpcFrame(IPC_FRAME_WARN_BYTES - 1)).toBe('ok')
    expect(classifyIpcFrame(IPC_FRAME_WARN_BYTES)).toBe('warn')
    expect(classifyIpcFrame(IPC_FRAME_MAX_BYTES)).toBe('warn')
    expect(classifyIpcFrame(IPC_FRAME_MAX_BYTES + 1)).toBe('oversized')
  })

  it('keeps the warn line strictly below the max line', () => {
    expect(IPC_FRAME_WARN_BYTES).toBeLessThan(IPC_FRAME_MAX_BYTES)
  })
})

describe('assertIpcFrameWithinLimit', () => {
  it('passes the max line through and refuses one byte past it', () => {
    expect(() => assertIpcFrameWithinLimit(IPC_FRAME_MAX_BYTES)).not.toThrow()
    expect(() => assertIpcFrameWithinLimit(IPC_FRAME_MAX_BYTES + 1)).toThrow(IpcFrameTooLargeError)
  })

  it('reports the offending size and the limit it broke', () => {
    try {
      assertIpcFrameWithinLimit(IPC_FRAME_MAX_BYTES + 4096)
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(IpcFrameTooLargeError)
      const e = err as IpcFrameTooLargeError
      expect(e.bytes).toBe(IPC_FRAME_MAX_BYTES + 4096)
      expect(e.limit).toBe(IPC_FRAME_MAX_BYTES)
      expect(e.code).toBe(IPC_FRAME_TOO_LARGE_CODE)
    }
  })
})

describe('reportIpcFrame', () => {
  it('keeps the most recent 64 frames oldest-first', () => {
    for (let i = 1; i <= 100; i++) report(i)
    const snapshot = snapshotIpcFrames()
    expect(snapshot).toHaveLength(64)
    expect(snapshot[0]?.bytes).toBe(37)
    expect(snapshot[63]?.bytes).toBe(100)
  })

  it('counts frames the ring can no longer hold', () => {
    report(IPC_FRAME_WARN_BYTES)
    for (let i = 0; i < 200; i++) report(1024)
    expect(ipcFrameStats()).toMatchObject({ seen: 201, warned: 1, oversized: 0 })
  })

  it('remembers the largest frame even after it is evicted from the ring', () => {
    report(IPC_FRAME_WARN_BYTES + 4096, { channel: 'acpHost', name: 'writeStdin' })
    for (let i = 0; i < 200; i++) report(512)
    const stats = ipcFrameStats()
    expect(stats.largestBytes).toBe(IPC_FRAME_WARN_BYTES + 4096)
    expect(stats.largestLabel).toBe('out response acpHost.writeStdin')
    expect(stats.warned).toBe(1)
    expect(snapshotIpcFrames().every((f) => f.bytes === 512)).toBe(true)
  })

  it('remembers a largest frame that never crossed the warn line', () => {
    // The post-crash question is "what is the biggest thing this process put on the
    // wire", and a frame under the warn threshold is still an answer — reporting it as
    // zero would read as "there were no large frames", the opposite of the truth.
    report(31 * 1024 * 1024, { channel: 'fileSearch', name: 'findFiles' })
    const stats = ipcFrameStats()
    expect(stats.largestBytes).toBe(31 * 1024 * 1024)
    expect(stats.largestLabel).toBe('out response fileSearch.findFiles')
    expect(stats).toMatchObject({ warned: 0, oversized: 0 })
  })

  it('records direction, kind and target of the newest frame', () => {
    report(2048, { direction: 'in', type: 'request', channel: 'fileService', name: 'readFile' })
    const [latest] = snapshotIpcFrames()
    expect(latest).toMatchObject({
      direction: 'in',
      bytes: 2048,
      type: 'request',
      channel: 'fileService',
      name: 'readFile',
    })
    expect(latest?.ts).toBeGreaterThan(0)
  })

  it('routes each tier to its own sink with the limit attached to oversized frames', () => {
    const oversized: IpcFrameOversizedInfo[] = []
    const warned: IpcFrameSizeInfo[] = []
    setIpcFrameDiagnostics({ onOversized: (i) => oversized.push(i), onWarn: (i) => warned.push(i) })
    report(1024, { channel: 'a', name: 'small' })
    report(IPC_FRAME_WARN_BYTES, { channel: 'b', name: 'big' })
    report(IPC_FRAME_MAX_BYTES + 1, { channel: 'c', name: 'huge', direction: 'in' })
    expect(warned).toEqual([
      {
        bytes: IPC_FRAME_WARN_BYTES,
        direction: 'out',
        type: 'response',
        channel: 'b',
        name: 'big',
        id: 0,
      },
    ])
    expect(oversized).toEqual([
      {
        bytes: IPC_FRAME_MAX_BYTES + 1,
        direction: 'in',
        type: 'response',
        channel: 'c',
        name: 'huge',
        id: 0,
        limit: IPC_FRAME_MAX_BYTES,
      },
    ])
  })

  it('is silent when no sink is installed', () => {
    expect(() => report(IPC_FRAME_MAX_BYTES + 1)).not.toThrow()
  })
})

describe('oversized report folding', () => {
  const collect = (): IpcFrameOversizedInfo[] => {
    const seen: IpcFrameOversizedInfo[] = []
    setIpcFrameDiagnostics({ onOversized: (i) => seen.push(i) })
    return seen
  }
  const huge = IPC_FRAME_MAX_BYTES + 1

  it('reports the first refusal of a target immediately', () => {
    const seen = collect()
    report(huge, { channel: 'file', name: 'read' })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.suppressed).toBeUndefined()
  })

  it('folds a burst of the same target into one report with the multiplier', () => {
    let at = 0
    resetIpcFrameDiagnosticsForTests(() => at)
    const seen = collect()
    for (let i = 0; i < 225; i++) report(huge, { channel: 'file', name: 'read' })
    expect(seen).toHaveLength(1)

    at = 1500
    report(huge, { channel: 'file', name: 'read' })
    expect(seen).toHaveLength(2)
    expect(seen[1]?.suppressed).toBe(224)
    expect(ipcFrameStats().oversized).toBe(226)
  })

  it('does not attribute one target to another when the offender changes', () => {
    const seen = collect()
    report(huge, { channel: 'file', name: 'read' })
    report(huge, { channel: 'file', name: 'read' })
    report(huge, { channel: 'search', name: 'list' })
    expect(seen).toHaveLength(2)
    expect(seen[1]?.name).toBe('list')
    expect(seen[1]?.suppressed).toBeUndefined()
  })

  it('folds inbound and outbound separately', () => {
    const seen = collect()
    report(huge, { direction: 'out', channel: 'file', name: 'read' })
    report(huge, { direction: 'in', channel: 'file', name: 'read' })
    expect(seen).toHaveLength(2)
  })
})

describe('frames that answer a request', () => {
  it('carries the request id, which is the only handle the wire gives on a response', () => {
    report(2048, { type: 'response', channel: '', name: '', id: 42 })
    const [latest] = snapshotIpcFrames()
    expect(latest?.id).toBe(42)
    expect(ipcFrameStats().largestLabel).toBe('out response #42')
  })

  it('names the channel and command once the receiver resolved the request', () => {
    report(2048, { type: 'response', channel: 'fileService', name: 'readFile', id: 42 })
    expect(ipcFrameStats().largestLabel).toBe('out response fileService.readFile #42')
    expect(formatIpcFrames(1)).toContain('response fileService.readFile #42')
  })

  it('degrades to the bare kind rather than a trailing space when nothing is known', () => {
    report(2048, { type: 'unparsed', channel: '', name: '', id: 0 })
    expect(ipcFrameStats().largestLabel).toBe('out unparsed')
  })

  it('leaves frames with no id unadorned', () => {
    report(2048, { type: 'event', channel: 'acpHost', name: 'onStdout' })
    expect(ipcFrameStats().largestLabel).toBe('out event acpHost.onStdout')
  })

  it('degrades a malformed id rather than printing it', () => {
    // The id comes off the wire. `id <= 0` alone would let `#undefined` onto the one
    // line whose whole job is to stay greppable.
    report(2048, { type: 'response', channel: '', name: '', id: Number.NaN })
    expect(ipcFrameStats().largestLabel).toBe('out response')
  })
})

describe('formatIpcFrameAlert', () => {
  const BASE: IpcFrameSizeInfo = {
    bytes: 47.6 * 1024 * 1024,
    direction: 'in',
    type: 'response',
    channel: '',
    name: '',
    id: 0,
  }
  const alert = (over: Partial<IpcFrameOversizedInfo>): string =>
    formatIpcFrameAlert({ ...BASE, ...over })

  it('names the request a large response body answers', () => {
    expect(alert({ channel: 'fileService', name: 'readFile', id: 42 })).toBe(
      'large inbound ipc frame 47.6MB (response fileService.readFile #42)',
    )
  })

  it('falls back to the kind and id when the receiver could not resolve the request', () => {
    // The line this replaces read `large inbound ipc frame 47.6MB` and nothing else —
    // the single most important alert in the package named nothing at all.
    expect(alert({ id: 42 })).toBe('large inbound ipc frame 47.6MB (response #42)')
  })

  it('still names frames that never had a channel', () => {
    expect(alert({ type: 'unparsed' })).toBe('large inbound ipc frame 47.6MB (unparsed)')
  })

  it('keeps the refusal wording and its folded multiplier', () => {
    expect(alert({ id: 7, limit: IPC_FRAME_MAX_BYTES, suppressed: 225 })).toBe(
      'refused inbound ipc frame 47.6MB, over the 128MB limit (response #7), +225 more folded',
    )
  })
})

describe('warn report folding', () => {
  const collectWarns = (): IpcFrameSizeInfo[] => {
    const seen: IpcFrameSizeInfo[] = []
    setIpcFrameDiagnostics({ onWarn: (i) => seen.push(i) })
    return seen
  }

  it('folds a burst of large sends into one report with the multiplier', () => {
    // A send-side report is by construction a loop (one payload per call), which is
    // exactly the shape that buried its own signal before the refusal tier was folded.
    let at = 0
    resetIpcFrameDiagnosticsForTests(() => at)
    const seen = collectWarns()
    for (let i = 0; i < 30; i++) {
      report(IPC_FRAME_WARN_BYTES, { direction: 'out', channel: 'acpHost', name: 'onStdout' })
    }
    expect(seen).toHaveLength(1)

    at = 1500
    report(IPC_FRAME_WARN_BYTES, { direction: 'out', channel: 'acpHost', name: 'onStdout' })
    expect(seen).toHaveLength(2)
    expect(seen[1]?.suppressed).toBe(29)
    expect(ipcFrameStats().warned).toBe(31)
  })

  it('reports every large inbound frame, folded or not', () => {
    const seen = collectWarns()
    for (let i = 0; i < 5; i++) {
      report(IPC_FRAME_WARN_BYTES, { direction: 'in', channel: 'acpHost', name: 'onStdout' })
    }
    expect(seen).toHaveLength(5)
  })
})

describe('formatIpcFrames', () => {
  it('reports the durable summary even with an empty ring', () => {
    expect(formatIpcFrames()).toContain('largest=0KiB')
    expect(formatIpcFrames()).toContain('no ipc frames recorded')
  })

  it('prints the headline and the tail, capped by the limit argument', () => {
    for (let i = 1; i <= 40; i++) report(i * 4096)
    const text = formatIpcFrames(3)
    const lines = text.split('\n')
    expect(lines[0]).toContain('seen=40')
    expect(lines).toHaveLength(4)
    expect(lines[3]).toContain('160KiB')
  })
})
