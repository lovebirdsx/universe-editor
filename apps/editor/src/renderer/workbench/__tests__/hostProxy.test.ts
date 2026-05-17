/*---------------------------------------------------------------------------------------------
 *  End-to-end verification that `ProxyChannel.toService<IHostService>` (registered
 *  directly in main.tsx, no wrapper class) routes events and method calls through
 *  the IPC layer.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import {
  ChannelServer,
  Emitter,
  IHostService,
  InMemoryMessagePassingProtocol,
  IpcService,
  ProxyChannel,
  type IHostServiceWire,
} from '@universe-editor/platform'
import { ServiceChannels } from '../../../shared/ipc/channelNames.js'

interface HostHarness {
  proxy: IHostService
  fake: FakeHost
  dispose: () => void
}

class FakeHost implements IHostServiceWire {
  declare readonly _serviceBrand: undefined
  private readonly _emitter = new Emitter<boolean>()
  readonly onDidChangeMaximized = this._emitter.event
  isMaximizedValue = false
  readonly minimize = vi.fn().mockResolvedValue(undefined)
  readonly toggleMaximize = vi.fn().mockResolvedValue(undefined)
  readonly close = vi.fn().mockResolvedValue(undefined)
  readonly devTools = vi.fn().mockResolvedValue(undefined)

  isMaximized(): Promise<boolean> {
    return Promise.resolve(this.isMaximizedValue)
  }
  minimizeWindow(): Promise<void> {
    return this.minimize()
  }
  toggleMaximizeWindow(): Promise<void> {
    return this.toggleMaximize()
  }
  closeWindow(): Promise<void> {
    return this.close()
  }
  toggleDevTools(): Promise<void> {
    return this.devTools()
  }
  showOpenFileDialog(): Promise<null> {
    return Promise.resolve(null)
  }
  showSaveFileDialog(): Promise<null> {
    return Promise.resolve(null)
  }
  showItemInFolder(): Promise<void> {
    return Promise.resolve()
  }
  openWithDefaultApp(_path: string): Promise<string> {
    return Promise.resolve('')
  }
  fire(v: boolean): void {
    this._emitter.fire(v)
  }
}

function setup({ platform = 'win32' }: { platform?: string } = {}): HostHarness {
  const [clientProto, serverProto] = InMemoryMessagePassingProtocol.createPair()
  const server = new ChannelServer(serverProto)
  const fake = new FakeHost()
  server.registerChannel(ServiceChannels.Host, ProxyChannel.fromService(fake))

  const ipc = new IpcService(clientProto)
  const proxy = ProxyChannel.toService<IHostService>(ipc.getChannel(ServiceChannels.Host), {
    properties: new Map<string, unknown>([['platform', platform]]),
  })

  return {
    proxy,
    fake,
    dispose: () => {
      ipc.dispose()
      server.dispose()
    },
  }
}

describe('IHostService proxy', () => {
  it('serves `platform` synchronously from the `properties` option', () => {
    const h = setup({ platform: 'darwin' })
    expect(h.proxy.platform).toBe('darwin')
    h.dispose()
  })

  it('returns the explicit `properties` value for any string (no coercion in the proxy)', () => {
    const h = setup({ platform: 'freebsd' })
    expect(h.proxy.platform).toBe('freebsd')
    h.dispose()
  })

  it('routes isMaximized() through the channel', async () => {
    const h = setup()
    h.fake.isMaximizedValue = true
    await expect(h.proxy.isMaximized()).resolves.toBe(true)
    h.dispose()
  })

  it('forwards onDidChangeMaximized events to local listeners', async () => {
    const h = setup()
    const received: boolean[] = []
    const sub = h.proxy.onDidChangeMaximized((v) => received.push(v))
    // Allow the subscribe envelope to reach the server.
    await new Promise((r) => setTimeout(r, 0))
    h.fake.fire(true)
    h.fake.fire(false)
    await new Promise((r) => setTimeout(r, 0))
    expect(received).toEqual([true, false])
    sub.dispose()
    h.dispose()
  })

  it('forwards method calls to the server implementation', async () => {
    const h = setup()
    await h.proxy.minimizeWindow()
    await h.proxy.toggleMaximizeWindow()
    await h.proxy.closeWindow()
    await h.proxy.toggleDevTools()
    expect(h.fake.minimize).toHaveBeenCalledTimes(1)
    expect(h.fake.toggleMaximize).toHaveBeenCalledTimes(1)
    expect(h.fake.close).toHaveBeenCalledTimes(1)
    expect(h.fake.devTools).toHaveBeenCalledTimes(1)
    h.dispose()
  })

  it('stops delivering events after the listener disposes', async () => {
    const h = setup()
    const received: boolean[] = []
    const sub = h.proxy.onDidChangeMaximized((v) => received.push(v))
    await new Promise((r) => setTimeout(r, 0))
    h.fake.fire(true)
    await new Promise((r) => setTimeout(r, 0))
    sub.dispose()
    await new Promise((r) => setTimeout(r, 0))
    h.fake.fire(false)
    await new Promise((r) => setTimeout(r, 0))
    expect(received).toEqual([true])
    h.dispose()
  })
})
