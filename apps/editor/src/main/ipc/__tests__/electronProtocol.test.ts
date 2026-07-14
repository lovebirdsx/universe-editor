/*---------------------------------------------------------------------------------------------
 *  Tests for ElectronProtocol's dead-frame gate. The gate is what breaks the
 *  send→console.error→log→send feedback loop that turns a renderer crash into a
 *  runaway disk/CPU spiral, so it is worth pinning down.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { on: vi.fn() } }))

const { ElectronProtocol } = await import('../electronProtocol.js')

type Handler = (...args: unknown[]) => void

class FakeWebContents {
  id = 1
  private _destroyed = false
  private readonly _handlers = new Map<string, Set<Handler>>()
  readonly sent: unknown[] = []
  throwOnSend = false

  on(event: string, handler: Handler): this {
    let set = this._handlers.get(event)
    if (!set) {
      set = new Set()
      this._handlers.set(event, set)
    }
    set.add(handler)
    return this
  }

  removeListener(event: string, handler: Handler): this {
    this._handlers.get(event)?.delete(handler)
    return this
  }

  emit(event: string, ...args: unknown[]): void {
    for (const h of this._handlers.get(event) ?? []) h(...args)
  }

  send(_channel: string, data: unknown): void {
    if (this.throwOnSend) throw new Error('Render frame was disposed before WebFrameMain')
    this.sent.push(data)
  }

  isDestroyed(): boolean {
    return this._destroyed
  }

  destroy(): void {
    this._destroyed = true
  }
}

function make(): { wc: FakeWebContents; protocol: InstanceType<typeof ElectronProtocol> } {
  const wc = new FakeWebContents()
  const protocol = new ElectronProtocol(wc as unknown as Electron.WebContents)
  return { wc, protocol }
}

afterEach(() => vi.clearAllMocks())

describe('ElectronProtocol dead-frame gate', () => {
  it('sends normally while the frame is alive', () => {
    const { wc, protocol } = make()
    protocol.send(new Uint8Array([1, 2, 3]))
    expect(wc.sent).toHaveLength(1)
  })

  it('drops sends after render-process-gone', () => {
    const { wc, protocol } = make()
    wc.emit('render-process-gone', {}, { reason: 'crashed' })
    protocol.send(new Uint8Array([1]))
    expect(wc.sent).toHaveLength(0)
  })

  it('drops sends during a reload window (did-start-loading) then resumes after did-finish-load', () => {
    const { wc, protocol } = make()
    wc.emit('did-start-loading')
    protocol.send(new Uint8Array([1]))
    expect(wc.sent).toHaveLength(0)

    wc.emit('did-finish-load')
    protocol.send(new Uint8Array([2]))
    expect(wc.sent).toHaveLength(1)
  })

  it('resumes after dom-ready commits the new frame', () => {
    const { wc, protocol } = make()
    wc.emit('render-process-gone', {}, { reason: 'crashed' })
    wc.emit('dom-ready')
    protocol.send(new Uint8Array([9]))
    expect(wc.sent).toHaveLength(1)
  })

  it('closes the gate when a send throws, so subsequent sends short-circuit', () => {
    const { wc, protocol } = make()
    wc.throwOnSend = true
    expect(() => protocol.send(new Uint8Array([1]))).not.toThrow()
    // Gate is now closed; a healthy send path would still be blocked until a
    // reload event reopens it.
    wc.throwOnSend = false
    protocol.send(new Uint8Array([2]))
    expect(wc.sent).toHaveLength(0)
  })

  it('stops sending once disconnected', () => {
    const { wc, protocol } = make()
    protocol.disconnect()
    protocol.send(new Uint8Array([1]))
    expect(wc.sent).toHaveLength(0)
  })
})
