/*---------------------------------------------------------------------------------------------
 *  Tests for InstantiationService with SyncDescriptor.supportsDelayedInstantiation = true.
 *  The service is wrapped in a Proxy backed by GlobalIdleValue and is only materialized on
 *  first non-event property access (or when the idle callback fires).
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { Emitter, Event } from '../../base/event.js'
import { SyncDescriptor } from '../../di/descriptors.js'
import { createDecorator, IInstantiationService } from '../../di/instantiation.js'
import { InstantiationService } from '../../di/instantiationService.js'
import { ServiceCollection } from '../../di/serviceCollection.js'

interface ICounter {
  readonly _serviceBrand: undefined
  readonly onDidChange: Event<number>
  readonly value: number
  inc(): void
}
const ICounter = createDecorator<ICounter>('counter-lazy-test')

let ctorCalls = 0

class Counter implements ICounter {
  declare readonly _serviceBrand: undefined
  private readonly _onDidChange = new Emitter<number>()
  readonly onDidChange = this._onDidChange.event
  private _value = 0
  constructor() {
    ctorCalls++
  }
  get value() {
    return this._value
  }
  inc() {
    this._value++
    this._onDidChange.fire(this._value)
  }
}

function makeService(supportsDelayedInstantiation: boolean): InstantiationService {
  ctorCalls = 0
  const services = new ServiceCollection()
  services.set(ICounter, new SyncDescriptor(Counter, [], supportsDelayedInstantiation))
  return new InstantiationService(services, true)
}

describe('InstantiationService: lazy services', () => {
  it('eager descriptor instantiates on first get', () => {
    const inst = makeService(false)
    inst.invokeFunction((a) => a.get(ICounter))
    expect(ctorCalls).toBe(1)
  })

  it('lazy descriptor does NOT instantiate on get alone', () => {
    const inst = makeService(true)
    inst.invokeFunction((a) => a.get(ICounter))
    expect(ctorCalls).toBe(0)
  })

  it('lazy descriptor does NOT instantiate when only an onDid* event is subscribed', () => {
    const inst = makeService(true)
    const counter = inst.invokeFunction((a) => a.get(ICounter))
    const sub = counter.onDidChange(() => {})
    expect(ctorCalls).toBe(0)
    sub.dispose()
    expect(ctorCalls).toBe(0)
  })

  it('first non-event property access materializes the instance', () => {
    const inst = makeService(true)
    const counter = inst.invokeFunction((a) => a.get(ICounter))
    expect(ctorCalls).toBe(0)
    void counter.value
    expect(ctorCalls).toBe(1)
  })

  it('early onDid* listeners are reattached and fire after materialization', () => {
    const inst = makeService(true)
    const counter = inst.invokeFunction((a) => a.get(ICounter))
    const received: number[] = []
    counter.onDidChange((v) => received.push(v))
    expect(ctorCalls).toBe(0)

    counter.inc() // forces materialization (`inc` is a function call)
    expect(ctorCalls).toBe(1)
    expect(received).toEqual([1])

    counter.inc()
    expect(received).toEqual([1, 2])
  })

  it('disposing an early listener before materialization prevents reattachment', () => {
    const inst = makeService(true)
    const counter = inst.invokeFunction((a) => a.get(ICounter))
    const received: number[] = []
    const sub = counter.onDidChange((v) => received.push(v))
    sub.dispose()

    counter.inc()
    expect(received).toEqual([])
  })

  it('method calls bind to the real instance and are cached on the proxy', () => {
    const inst = makeService(true)
    const counter = inst.invokeFunction((a) => a.get(ICounter))
    counter.inc()
    counter.inc()
    counter.inc()
    expect(counter.value).toBe(3)
    expect(ctorCalls).toBe(1)
  })

  it('multiple accessor.get(ID) return the same proxy', () => {
    const inst = makeService(true)
    const a = inst.invokeFunction((acc) => acc.get(ICounter))
    const b = inst.invokeFunction((acc) => acc.get(ICounter))
    expect(a).toBe(b)
  })

  it('disposing the service collection disposes the materialized service', () => {
    const disposeSpy = vi.fn()
    class Disposable {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      static instance: any
      ping = 'pong'
      dispose() {
        disposeSpy()
      }
    }
    const services = new ServiceCollection()
    const ID = createDecorator<Disposable>('disposable-lazy')
    services.set(ID, new SyncDescriptor(Disposable, [], true))
    const inst2 = new InstantiationService(services, true)
    const proxy = inst2.invokeFunction((acc) => acc.get(ID))
    // touch a property to materialize
    void proxy.ping
    inst2.dispose()
    expect(disposeSpy).toHaveBeenCalledOnce()
  })

  it('non-materialized lazy service does not run dispose on container disposal', () => {
    const disposeSpy = vi.fn()
    class Disposable {
      ping = 'pong'
      dispose() {
        disposeSpy()
      }
    }
    const ID = createDecorator<Disposable>('disposable-lazy-untouched')
    const services = new ServiceCollection()
    services.set(ID, new SyncDescriptor(Disposable, [], true))
    const inst = new InstantiationService(services, true)
    // Get proxy but never touch — should not materialize.
    inst.invokeFunction((acc) => acc.get(ID))
    inst.dispose()
    expect(disposeSpy).not.toHaveBeenCalled()
  })

  it('IInstantiationService is still injectable into lazy services', () => {
    class WithDep implements ICounter {
      declare readonly _serviceBrand: undefined
      readonly onDidChange = Event.None
      value = 42
      constructor(@IInstantiationService readonly i: IInstantiationService) {
        ctorCalls++
        expect(i).toBeDefined()
      }
      inc() {}
    }
    ctorCalls = 0
    const services = new ServiceCollection()
    services.set(ICounter, new SyncDescriptor(WithDep, [], true))
    const inst = new InstantiationService(services, true)
    const c = inst.invokeFunction((a) => a.get(ICounter))
    expect(ctorCalls).toBe(0)
    expect(c.value).toBe(42)
    expect(ctorCalls).toBe(1)
  })
})
