/*---------------------------------------------------------------------------------------------
 *  Tests for TerminalMainService — uses a fake PtySpawner so no native module loads.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { IDisposable } from '@universe-editor/platform'
import type { IPty } from '@lydell/node-pty'
import { TerminalMainService, type PtySpawner } from '../terminalMainService.js'

class FakePty implements IPty {
  cols = 80
  rows = 24
  process = 'fake'
  handleFlowControl = false
  readonly written: string[] = []
  readonly resizeCalls: Array<{ cols: number; rows: number }> = []
  killed = false

  private _data: ((d: string) => void) | undefined
  private _exit: ((e: { exitCode: number; signal?: number }) => void) | undefined

  constructor(readonly pid: number) {}

  readonly onData = (listener: (d: string) => void): IDisposable => {
    this._data = listener
    return { dispose: () => (this._data = undefined) }
  }
  readonly onExit = (listener: (e: { exitCode: number; signal?: number }) => void): IDisposable => {
    this._exit = listener
    return { dispose: () => (this._exit = undefined) }
  }

  resize(cols: number, rows: number): void {
    this.resizeCalls.push({ cols, rows })
  }
  clear(): void {}
  write(data: string | Buffer): void {
    this.written.push(typeof data === 'string' ? data : data.toString())
  }
  kill(): void {
    this.killed = true
  }
  pause(): void {}
  resume(): void {}

  fireData(d: string): void {
    this._data?.(d)
  }
  fireExit(exitCode: number, signal?: number): void {
    this._exit?.(signal === undefined ? { exitCode } : { exitCode, signal })
  }
}

function makeService(): { service: TerminalMainService; ptys: FakePty[] } {
  const ptys: FakePty[] = []
  const spawner: PtySpawner = () => {
    const p = new FakePty(1000 + ptys.length)
    ptys.push(p)
    return p
  }
  return { service: new TerminalMainService(spawner), ptys }
}

describe('TerminalMainService', () => {
  it('create returns info with pid/shell/name', async () => {
    const { service, ptys } = makeService()
    const info = await service.create({ shell: 'bash', name: 'T1' })
    expect(info.pid).toBe(1000)
    expect(info.shell).toBe('bash')
    expect(info.name).toBe('T1')
    expect(ptys).toHaveLength(1)
  })

  it('defaults the name to the shell basename', async () => {
    const { service } = makeService()
    const info = await service.create({ shell: '/usr/bin/zsh' })
    expect(info.name).toBe('zsh')
  })

  it('routes input to the owning pty', async () => {
    const { service, ptys } = makeService()
    const info = await service.create({})
    await service.input(info.id, 'ls\n')
    expect(ptys[0]!.written).toEqual(['ls\n'])
  })

  it('forwards resize', async () => {
    const { service, ptys } = makeService()
    const info = await service.create({})
    await service.resize(info.id, 100, 30)
    expect(ptys[0]!.resizeCalls).toEqual([{ cols: 100, rows: 30 }])
  })

  it('emits onData tagged with the terminal id', async () => {
    const { service, ptys } = makeService()
    const events: Array<{ id: string; data: string }> = []
    service.onData((e) => events.push(e))
    const info = await service.create({})
    ptys[0]!.fireData('hello')
    expect(events).toEqual([{ id: info.id, data: 'hello' }])
  })

  it('isolates data between terminals', async () => {
    const { service, ptys } = makeService()
    await service.create({})
    const b = await service.create({})
    const got: Array<{ id: string; data: string }> = []
    service.onData((e) => got.push(e))
    ptys[1]!.fireData('fromB')
    expect(got).toEqual([{ id: b.id, data: 'fromB' }])
  })

  it('onExit fires and removes the terminal from the list', async () => {
    const { service, ptys } = makeService()
    const exits: Array<{ id: string; exitCode: number }> = []
    service.onExit((e) => exits.push(e))
    const info = await service.create({})
    ptys[0]!.fireExit(0)
    expect(exits).toEqual([{ id: info.id, exitCode: 0 }])
    expect(await service.list()).toHaveLength(0)
  })

  it('kill signals the pty', async () => {
    const { service, ptys } = makeService()
    const info = await service.create({})
    await service.kill(info.id)
    expect(ptys[0]!.killed).toBe(true)
  })

  it('release kills and drops the terminal', async () => {
    const { service, ptys } = makeService()
    const info = await service.create({})
    await service.release(info.id)
    expect(ptys[0]!.killed).toBe(true)
    expect(await service.list()).toHaveLength(0)
  })

  it('list returns created terminals in order', async () => {
    const { service } = makeService()
    await service.create({ name: 'A' })
    await service.create({ name: 'B' })
    const list = await service.list()
    expect(list.map((t) => t.name)).toEqual(['A', 'B'])
  })

  it('strips denylisted env vars before spawning', async () => {
    let captured: Record<string, string> | undefined
    const spawner: PtySpawner = (_file, _args, opts) => {
      captured = opts.env
      return new FakePty(1)
    }
    const service = new TerminalMainService(spawner)
    await service.create({ env: { FOO: 'bar', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--x' } })
    expect(captured?.['FOO']).toBe('bar')
    expect(captured?.['ELECTRON_RUN_AS_NODE']).toBeUndefined()
    expect(captured?.['NODE_OPTIONS']).toBeUndefined()
  })

  it('dispose kills every live terminal', async () => {
    const { service, ptys } = makeService()
    await service.create({})
    await service.create({})
    service.dispose()
    expect(ptys.every((p) => p.killed)).toBe(true)
  })

  it('rejects operations on unknown ids', async () => {
    const { service } = makeService()
    await expect(service.input('nope', 'x')).rejects.toThrow(/unknown terminal/)
    await expect(service.resize('nope', 1, 1)).rejects.toThrow(/unknown terminal/)
  })
})
