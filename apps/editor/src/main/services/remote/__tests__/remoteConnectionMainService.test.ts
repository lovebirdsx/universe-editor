/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/remote/remoteConnectionMainService.ts
 *  Drives the connection state machine with a fake spawner + a hand-rolled
 *  stdio handshake responder (the framing protocol round-trips through the fake
 *  child's stdin/stdout), so no real process is launched.
 *--------------------------------------------------------------------------------------------*/

import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { REMOTE_PROTOCOL_VERSION, type IRemoteHandshakeInfo } from '@universe-editor/platform'
import {
  RemoteConnectionMainService,
  resolveRemoteServerCommand,
  type RemoteSpawner,
} from '../remoteConnectionMainService.js'

vi.mock('electron', () => ({ app: {} }))

const GOOD_INFO: IRemoteHandshakeInfo = {
  protocolVersion: REMOTE_PROTOCOL_VERSION,
  os: 'linux',
  arch: 'x64',
  pathCaseSensitive: true,
}

class FakeStream extends EventEmitter {
  setEncoding = vi.fn()
}

class FakeStdin extends EventEmitter {
  destroyed = false
  writable = true
  ended = false
  writes: string[] = []
  write(data: string, _enc: string, cb: (err?: Error | null) => void): boolean {
    this.writes.push(data)
    cb(null)
    return true
  }
  end(): void {
    this.ended = true
  }
}

class FakeProc extends EventEmitter {
  readonly stdout = new FakeStream()
  readonly stderr = new FakeStream()
  readonly stdin = new FakeStdin()
  killCalls = 0
  kill(_signal?: NodeJS.Signals): boolean {
    this.killCalls++
    return true
  }
  emitStdout(data: string): void {
    this.stdout.emit('data', Buffer.from(data, 'utf8'))
  }
  emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.emit('exit', code, signal)
  }
}

/** Answer the pending `handshake.getInfo` request on a proc's stdout. */
function respondHandshake(proc: FakeProc, info: IRemoteHandshakeInfo): void {
  let id: number | null = null
  for (const write of proc.stdin.writes) {
    for (const frame of write.split('\n')) {
      if (!frame) continue
      const msg = JSON.parse(frame) as {
        type?: string
        id?: number
        channel?: string
        command?: string
      }
      if (msg.type === 'request' && msg.channel === 'handshake' && msg.command === 'getInfo') {
        id = msg.id ?? null
      }
    }
  }
  if (id === null) throw new Error('no handshake request observed')
  proc.emitStdout(`${JSON.stringify({ type: 'response', id, data: info })}\n`)
}

function makeService(): { svc: RemoteConnectionMainService; procs: FakeProc[] } {
  const procs: FakeProc[] = []
  const spawner: RemoteSpawner = (_command, _args, _options) => {
    const proc = new FakeProc()
    procs.push(proc)
    return proc as unknown as ChildProcessWithoutNullStreams
  }
  return { svc: new RemoteConnectionMainService(spawner, undefined, undefined), procs }
}

describe('resolveRemoteServerCommand', () => {
  it('defaults to ssh with the authority validated', () => {
    expect(resolveRemoteServerCommand(undefined, 'host')).toEqual({
      command: 'ssh',
      args: ['-T', '-o', 'BatchMode=yes', 'host', 'universe-editor-server'],
    })
  })

  it('rejects an empty authority', () => {
    expect(() => resolveRemoteServerCommand(undefined, '')).toThrow(/non-empty authority/)
  })

  it('rejects an authority that looks like an ssh option', () => {
    expect(() => resolveRemoteServerCommand(undefined, '-oProxyCommand=evil')).toThrow(
      /must not start with '-'/,
    )
  })

  it('parses a whitespace-split custom command without appending authority', () => {
    expect(resolveRemoteServerCommand('node /srv/remote.js --port 22', 'host')).toEqual({
      command: 'node',
      args: ['/srv/remote.js', '--port', '22'],
    })
  })

  it('parses a JSON array form (spaces in a windows path)', () => {
    expect(
      resolveRemoteServerCommand('["C:/Program Files/node/node.exe","C:/srv/remote.js"]', 'host'),
    ).toEqual({
      command: 'C:/Program Files/node/node.exe',
      args: ['C:/srv/remote.js'],
    })
  })
})

describe('RemoteConnectionMainService', () => {
  let svc: RemoteConnectionMainService | undefined

  afterEach(() => {
    svc?.dispose()
    svc = undefined
  })

  it('handshakes and memoizes the connection per authority', async () => {
    const made = makeService()
    svc = made.svc
    const p = svc.getConnection('host')
    respondHandshake(made.procs[0]!, GOOD_INFO)
    const conn = await p
    expect(conn.authority).toBe('host')
    expect(conn.info.os).toBe('linux')
    await expect(svc.getConnection('host')).resolves.toBe(conn)
  })

  it('rejects and kills on a protocol version mismatch', async () => {
    const made = makeService()
    svc = made.svc
    const p = svc.getConnection('host')
    respondHandshake(made.procs[0]!, { ...GOOD_INFO, protocolVersion: REMOTE_PROTOCOL_VERSION + 1 })
    await expect(p).rejects.toThrow(/version mismatch/)
    expect(made.procs[0]!.killCalls).toBeGreaterThan(0)
  })

  it('reconnects with backoff after an unexpected exit and swaps the connection object', async () => {
    vi.useFakeTimers()
    try {
      const made = makeService()
      svc = made.svc
      const firstP = svc.getConnection('host')
      respondHandshake(made.procs[0]!, GOOD_INFO)
      const first = await firstP
      let closed = false
      first.onDidClose(() => {
        closed = true
      })

      made.procs[0]!.emitExit(1, null)
      expect(closed).toBe(true)
      expect(made.procs.length).toBe(1)

      await vi.advanceTimersByTimeAsync(1000)
      expect(made.procs.length).toBe(2)
      respondHandshake(made.procs[1]!, GOOD_INFO)
      const second = await svc.getConnection('host')
      expect(second).not.toBe(first)
      expect(second.authority).toBe('host')
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives up (failed) after too many crashes in the window', async () => {
    vi.useFakeTimers()
    try {
      const made = makeService()
      svc = made.svc
      const p0 = svc.getConnection('host')
      respondHandshake(made.procs[0]!, GOOD_INFO)
      await p0
      made.procs[0]!.emitExit(1, null)

      for (let i = 0; i < 3; i++) {
        await vi.advanceTimersByTimeAsync(1000 * 2 ** i)
        respondHandshake(made.procs[i + 1]!, GOOD_INFO)
        await svc.getConnection('host')
        made.procs[i + 1]!.emitExit(1, null)
      }

      await expect(svc.getConnection('host')).rejects.toThrow(/failed/)
    } finally {
      vi.useRealTimers()
    }
  })
})
