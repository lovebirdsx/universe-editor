/*---------------------------------------------------------------------------------------------
 *  Tests for ElectronProtocol's dead-frame gate. The gate is what breaks the
 *  send→console.error→log→send feedback loop that turns a renderer crash into a
 *  runaway disk/CPU spiral, so it is worth pinning down.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { on: vi.fn() } }))

const { ElectronProtocol, FRAME_UNREACHABLE_LATCH_MS } = await import('../electronProtocol.js')

type Handler = (...args: unknown[]) => void

class FakeWebContents {
  id = 1
  private _destroyed = false
  private _crashed = false
  readonly _handlers = new Map<string, Set<Handler>>()
  readonly sent: unknown[] = []
  throwOnSend = false
  mainFrame = { isDestroyed: () => false, detached: false }

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

  isCrashed(): boolean {
    return this._crashed
  }

  destroy(): void {
    this._destroyed = true
  }

  /** Renderer dies with no event — the shipped crash's ~48s blind window. */
  crashSilently(): void {
    this._crashed = true
    this.mainFrame.detached = true
  }

  /** A reload gave the WebContents a fresh process and frame tree. */
  revive(): void {
    this._crashed = false
    this.mainFrame.detached = false
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

  it('drops sends during a main-frame reload (did-start-navigation) then resumes after did-finish-load', () => {
    const { wc, protocol } = make()
    wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    protocol.send(new Uint8Array([1]))
    expect(wc.sent).toHaveLength(0)

    wc.emit('did-finish-load')
    protocol.send(new Uint8Array([2]))
    expect(wc.sent).toHaveLength(1)
  })

  it('resumes before dom-ready when the new renderer sends its first IPC request', () => {
    const { wc, protocol } = make()
    const received: Uint8Array[] = []
    protocol.onMessage((message) => received.push(message))

    wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    protocol.send(new Uint8Array([1]))
    expect(wc.sent).toHaveLength(0)

    protocol.acceptMessage(new Uint8Array([2]))
    expect(received).toEqual([new Uint8Array([2])])

    protocol.send(new Uint8Array([3]))
    expect(wc.sent).toHaveLength(1)
  })

  it('keeps sending when a SUBFRAME (webview iframe) navigates', () => {
    // Regression: a webview <iframe> navigating fires did-start-navigation with
    // isMainFrame=false. It must NOT close the gate — nothing reopens it for a
    // subframe, so the main-frame IPC channel would stay pinned shut and every
    // custom-editor RPC would time out.
    const { wc, protocol } = make()
    wc.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
    protocol.send(new Uint8Array([1]))
    expect(wc.sent).toHaveLength(1)
  })

  it('keeps sending on a same-document main-frame navigation (hashchange/pushState)', () => {
    const { wc, protocol } = make()
    wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    protocol.send(new Uint8Array([1]))
    expect(wc.sent).toHaveLength(1)
  })

  it('does NOT let dom-ready reopen the gate after a crash — only an inbound message does', () => {
    // A dying frame keeps emitting document lifecycle events for a while after the
    // renderer is gone; each reopen costs another failed send, which is how a crash
    // becomes a flood.
    const { wc, protocol } = make()
    wc.emit('render-process-gone', {}, { reason: 'crashed' })
    wc.emit('dom-ready')
    protocol.send(new Uint8Array([9]))
    expect(wc.sent).toHaveLength(0)

    // An inbound message is proof the frame is executing our code.
    protocol.acceptMessage(new Uint8Array([1]))
    protocol.send(new Uint8Array([9]))
    expect(wc.sent).toHaveLength(1)
  })

  it('keeps a normal reload reopening on dom-ready', () => {
    // The dead-frame latch is only set by evidence of death. A plain navigation must
    // still recover through the lifecycle events, or a reload pins the channel shut.
    const { wc, protocol } = make()
    wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    wc.emit('dom-ready')
    protocol.send(new Uint8Array([9]))
    expect(wc.sent).toHaveLength(1)
  })

  it('lets a healthy window reopen after the latch expires, so it cannot stay deaf', () => {
    // The failure text names no window, so `markRendererFramesUnreachable` shuts every
    // window's gate — including healthy ones, which would otherwise drop every event
    // push until they happened to send something.
    const now = vi.spyOn(Date, 'now')
    let clock = 1_000_000
    now.mockImplementation(() => clock)
    try {
      const { wc, protocol } = make()
      protocol.markFrameUnreachable()
      wc.emit('dom-ready')
      protocol.send(new Uint8Array([9]))
      expect(wc.sent).toHaveLength(0)

      clock += FRAME_UNREACHABLE_LATCH_MS + 1
      wc.emit('did-finish-load')
      protocol.send(new Uint8Array([9]))
      expect(wc.sent).toHaveLength(1)
    } finally {
      now.mockRestore()
    }
  })

  it('re-latches on the next send failure, so the flood stays bounded per latch window', () => {
    const now = vi.spyOn(Date, 'now')
    let clock = 1_000_000
    now.mockImplementation(() => clock)
    try {
      const { wc, protocol } = make()
      wc.crashSilently()
      let probes = 0
      const original = wc.isCrashed.bind(wc)
      wc.isCrashed = () => (probes++, original())

      protocol.send(new Uint8Array([1]))
      expect(probes).toBe(1)

      // The latch lifts while the renderer is still gone: the life cycle event reopens the
      // gate, the next send probes once and shuts it again — one probe per window rather
      // than one per send.
      clock += FRAME_UNREACHABLE_LATCH_MS + 1
      wc.emit('dom-ready')
      for (let i = 0; i < 20; i++) protocol.send(new Uint8Array([i]))
      expect(probes).toBe(2)
      expect(wc.sent).toHaveLength(0)
    } finally {
      now.mockRestore()
    }
  })

  it('closes the gate on a send that throws, so subsequent sends short-circuit', () => {
    const { wc, protocol } = make()
    wc.throwOnSend = true
    expect(() => protocol.send(new Uint8Array([1]))).not.toThrow()
    // Gate is now closed; a healthy send path would still be blocked until the
    // frame proves itself with an inbound message.
    wc.throwOnSend = false
    protocol.send(new Uint8Array([2]))
    expect(wc.sent).toHaveLength(0)
  })

  describe('liveness probe (the crash that arrived before render-process-gone)', () => {
    it('refuses to send to a crashed renderer even though no event fired', () => {
      const { wc, protocol } = make()
      wc.crashSilently()
      protocol.send(new Uint8Array([1]))
      expect(wc.sent).toHaveLength(0)
    })

    it('refuses to send once the main frame reports itself detached', () => {
      const { wc, protocol } = make()
      wc.mainFrame.detached = true
      protocol.send(new Uint8Array([1]))
      expect(wc.sent).toHaveLength(0)
    })

    it('refuses to send once the frame is destroyed', () => {
      const { wc, protocol } = make()
      wc.mainFrame.isDestroyed = () => true
      protocol.send(new Uint8Array([1]))
      expect(wc.sent).toHaveLength(0)
    })

    it('probes once, then latches — a flood costs one probe, not one per send', () => {
      const { wc, protocol } = make()
      wc.crashSilently()
      let probes = 0
      const original = wc.isCrashed.bind(wc)
      wc.isCrashed = () => (probes++, original())

      for (let i = 0; i < 50; i++) protocol.send(new Uint8Array([i]))
      expect(wc.sent).toHaveLength(0)
      expect(probes).toBe(1)

      // A reload gives the WebContents a new process, and the new frame's first
      // message reopens the gate — the probe then passes again.
      wc.revive()
      protocol.acceptMessage(new Uint8Array([1]))
      protocol.send(new Uint8Array([2]))
      expect(wc.sent).toHaveLength(1)
    })
  })

  it('markRendererFramesUnreachable closes every window gate without firing onDidClose', async () => {
    const { markRendererFramesUnreachable } = await import('../electronProtocol.js')
    const { wc, protocol } = make()
    const onClose = vi.fn()
    protocol.onDidClose(onClose)

    markRendererFramesUnreachable()
    expect(onClose).not.toHaveBeenCalled()
    protocol.send(new Uint8Array([1]))
    expect(wc.sent).toHaveLength(0)

    wc.revive()
    protocol.acceptMessage(new Uint8Array([1]))
    protocol.send(new Uint8Array([2]))
    expect(wc.sent).toHaveLength(1)
    protocol.disconnect()
  })

  it("recognizes Electron's frame-send failure text", async () => {
    const { FRAME_SEND_FAILURE_PATTERN } = await import('../electronProtocol.js')
    const text =
      'Error: Error sending from webFrameMain: Render frame was disposed before WebFrameMain could be accessed'
    expect(FRAME_SEND_FAILURE_PATTERN.test(text)).toBe(true)
    expect(FRAME_SEND_FAILURE_PATTERN.test('Error sending from webContents')).toBe(true)
    expect(FRAME_SEND_FAILURE_PATTERN.test('some unrelated error')).toBe(false)
  })

  it('stops sending once disconnected', () => {
    const { wc, protocol } = make()
    protocol.disconnect()
    protocol.send(new Uint8Array([1]))
    expect(wc.sent).toHaveLength(0)
  })

  it('fires onDidClose on render-process-gone so ChannelServer drops event subscriptions', () => {
    const { wc, protocol } = make()
    const onClose = vi.fn()
    protocol.onDidClose(onClose)
    wc.emit('render-process-gone', {}, { reason: 'crashed' })
    expect(onClose).toHaveBeenCalledTimes(1)
    protocol.disconnect()
  })

  it('does NOT fire onDidClose on a main-frame reload navigation', () => {
    // Reload re-subscriptions land AFTER the new frame reopens the gate; a
    // close signal here could clear them with nothing to rebuild them. Only
    // the unbounded crash flood fires the signal.
    const { wc, protocol } = make()
    const onClose = vi.fn()
    protocol.onDidClose(onClose)
    wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect(onClose).not.toHaveBeenCalled()
    protocol.disconnect()
  })

  it('fires onDidClose on disconnect (window destroyed)', () => {
    const { protocol } = make()
    const onClose = vi.fn()
    protocol.onDidClose(onClose)
    protocol.disconnect()
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
