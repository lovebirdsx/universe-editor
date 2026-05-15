/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/ipc/proxyChannel.ts
 *
 *  Covers (spread-args + properties convention):
 *  - fromService/toService method call round-trip with natural multi-arg signatures
 *  - error propagation (throw -> rejected promise)
 *  - subscribe/unsubscribe lifecycle via Event<T>
 *  - multiple local subscribers share a single server-side subscription
 *  - property/method reference caching
 *  - `properties` option short-circuits to local synchronous values
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { ChannelClient, ChannelServer, InMemoryMessagePassingProtocol } from '../../ipc/ipc.js'
import { ProxyChannel } from '../../ipc/proxyChannel.js'
import { Emitter, Event } from '../../base/event.js'

async function flushMicrotasks(n = 10): Promise<void> {
  for (let i = 0; i < n; i++) {
    await Promise.resolve()
  }
}

interface IMathService {
  readonly _serviceBrand: undefined
  readonly onDidCompute: Event<number>
  add(a: number, b: number): Promise<number>
  fail(): Promise<void>
}

class MathService implements IMathService {
  declare readonly _serviceBrand: undefined
  private readonly _onDidCompute = new Emitter<number>()
  readonly onDidCompute = this._onDidCompute.event

  add(a: number, b: number): Promise<number> {
    const r = a + b
    this._onDidCompute.fire(r)
    return Promise.resolve(r)
  }

  fail(): Promise<void> {
    throw new Error('intentional')
  }

  emit(value: number): void {
    this._onDidCompute.fire(value)
  }
}

function setup(): { service: MathService; proxy: IMathService; cleanup: () => void } {
  const [clientProto, serverProto] = InMemoryMessagePassingProtocol.createPair()
  const server = new ChannelServer(serverProto)
  const client = new ChannelClient(clientProto)
  const service = new MathService()
  server.registerChannel('math', ProxyChannel.fromService(service))
  const proxy = ProxyChannel.toService<IMathService>(client.getChannel('math'))
  return {
    service,
    proxy,
    cleanup: () => {
      client.dispose()
      server.dispose()
    },
  }
}

describe('ProxyChannel.toService / fromService', () => {
  it('routes method calls with natural multi-arg signatures and resolves results', async () => {
    const { proxy, cleanup } = setup()
    const result = await proxy.add(3, 4)
    expect(result).toBe(7)
    cleanup()
  })

  it('propagates thrown errors as rejected promises', async () => {
    const { proxy, cleanup } = setup()
    await expect(proxy.fail()).rejects.toThrow('intentional')
    cleanup()
  })

  it('forwards events from server to client via subscribe', async () => {
    const { service, proxy, cleanup } = setup()
    const received: number[] = []
    const sub = proxy.onDidCompute((v) => received.push(v))
    await flushMicrotasks()
    service.emit(42)
    service.emit(7)
    await flushMicrotasks()
    expect(received).toEqual([42, 7])
    sub.dispose()
    cleanup()
  })

  it('stops delivering events after the last listener unsubscribes', async () => {
    const { service, proxy, cleanup } = setup()
    const received: number[] = []
    const sub = proxy.onDidCompute((v) => received.push(v))
    await flushMicrotasks()
    service.emit(1)
    await flushMicrotasks()
    sub.dispose()
    await flushMicrotasks()
    service.emit(2)
    await flushMicrotasks()
    expect(received).toEqual([1])
    cleanup()
  })

  it('caches method and event references across property reads', () => {
    const { proxy, cleanup } = setup()
    expect(proxy.add).toBe(proxy.add)
    expect(proxy.onDidCompute).toBe(proxy.onDidCompute)
    cleanup()
  })

  it('multiple local subscribers share a single server-side subscription', async () => {
    const { service, proxy, cleanup } = setup()
    const a: number[] = []
    const b: number[] = []
    const subA = proxy.onDidCompute((v) => a.push(v))
    const subB = proxy.onDidCompute((v) => b.push(v))
    await flushMicrotasks()
    service.emit(9)
    await flushMicrotasks()
    expect(a).toEqual([9])
    expect(b).toEqual([9])
    subA.dispose()
    subB.dispose()
    cleanup()
  })

  it('rejects unknown method calls', async () => {
    const { proxy, cleanup } = setup()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyProxy = proxy as any
    await expect(anyProxy.missingMethod(1)).rejects.toThrow('Method not found: missingMethod')
    cleanup()
  })
})

describe('ProxyChannel `properties` option', () => {
  interface IEnvService {
    readonly _serviceBrand: undefined
    readonly platform: string
    readonly onDidCompute: Event<number>
    add(a: number, b: number): Promise<number>
  }

  it('returns sync values from `properties` without invoking the channel', async () => {
    const [clientProto, serverProto] = InMemoryMessagePassingProtocol.createPair()
    const server = new ChannelServer(serverProto)
    const client = new ChannelClient(clientProto)
    const service = new MathService()
    server.registerChannel('env', ProxyChannel.fromService(service))

    const proxy = ProxyChannel.toService<IEnvService>(client.getChannel('env'), {
      properties: new Map([['platform', 'darwin']]),
    })

    // Sync property bypasses IPC entirely.
    expect(proxy.platform).toBe('darwin')

    // Non-property keys still go over the channel.
    const sum = await proxy.add(2, 5)
    expect(sum).toBe(7)

    client.dispose()
    server.dispose()
  })
})

describe('IPC subscribe/unsubscribe envelope', () => {
  it('does not deliver events before subscribe arrives at the server', async () => {
    const { service, proxy, cleanup } = setup()
    service.emit(100)
    await flushMicrotasks()
    const received: number[] = []
    proxy.onDidCompute((v) => received.push(v))
    await flushMicrotasks()
    service.emit(200)
    await flushMicrotasks()
    expect(received).toEqual([200])
    cleanup()
  })
})
