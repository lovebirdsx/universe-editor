/*---------------------------------------------------------------------------------------------
 *  Tests for the registerSingleton service registry (di/extensions.ts) and the kernel's
 *  markAsSingleton-on-materialization behavior that keeps container-owned services out of
 *  Disposable leak reports.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { Disposable, DisposableTracker, setDisposableTracker } from '../../base/lifecycle.js'
import { SyncDescriptor } from '../../di/descriptors.js'
import {
  getSingletonServiceDescriptors,
  InstantiationType,
  registerSingleton,
} from '../../di/extensions.js'
import { createDecorator } from '../../di/instantiation.js'
import { InstantiationService } from '../../di/instantiationService.js'
import { ServiceCollection } from '../../di/serviceCollection.js'

interface IFoo {
  readonly _serviceBrand: undefined
}
class Foo implements IFoo {
  declare readonly _serviceBrand: undefined
}

describe('registerSingleton / getSingletonServiceDescriptors', () => {
  it('Eager stores a non-delayed descriptor', () => {
    const ID = createDecorator<IFoo>('extensions-test-eager')
    registerSingleton(ID, Foo, InstantiationType.Eager)
    const entry = getSingletonServiceDescriptors().find(([id]) => id === ID)
    expect(entry).toBeDefined()
    expect(entry![1].ctor).toBe(Foo)
    expect(entry![1].supportsDelayedInstantiation).toBe(false)
  })

  it('Delayed stores a delayed descriptor', () => {
    const ID = createDecorator<IFoo>('extensions-test-delayed')
    registerSingleton(ID, Foo, InstantiationType.Delayed)
    const entry = getSingletonServiceDescriptors().find(([id]) => id === ID)
    expect(entry).toBeDefined()
    expect(entry![1].supportsDelayedInstantiation).toBe(true)
  })

  it('SyncDescriptor overload is stored verbatim', () => {
    const ID = createDecorator<IFoo>('extensions-test-descriptor')
    const desc = new SyncDescriptor(Foo, [], true)
    registerSingleton(ID, desc)
    const entry = getSingletonServiceDescriptors().find(([id]) => id === ID)
    expect(entry![1]).toBe(desc)
  })

  it('registered descriptors instantiate correctly when fed into a collection', () => {
    const ID = createDecorator<IFoo>('extensions-test-instantiate')
    registerSingleton(ID, Foo, InstantiationType.Eager)
    const services = new ServiceCollection()
    for (const [id, descriptor] of getSingletonServiceDescriptors()) {
      if (!services.has(id)) services.set(id, descriptor)
    }
    const inst = new InstantiationService(services, true)
    expect(inst.invokeFunction((a) => a.get(ID))).toBeInstanceOf(Foo)
  })
})

describe('markAsSingleton on container materialization', () => {
  it('a plain tracked disposable IS reported as a leak (control)', () => {
    const tracker = new DisposableTracker()
    setDisposableTracker(tracker)
    try {
      class Orphan extends Disposable {}
      const orphan = new Orphan()
      expect(tracker.computeLeakingDisposables()).toBeDefined()
      orphan.dispose()
    } finally {
      setDisposableTracker(null)
    }
  })

  it('eager container-materialized disposable is excluded from leak reports', () => {
    const tracker = new DisposableTracker()
    setDisposableTracker(tracker)
    try {
      class Svc extends Disposable {
        declare readonly _serviceBrand: undefined
      }
      const ID = createDecorator<Svc>('extensions-test-eager-leak')
      const services = new ServiceCollection()
      services.set(ID, new SyncDescriptor(Svc, [], false))
      const inst = new InstantiationService(services, true)
      inst.invokeFunction((a) => a.get(ID))
      expect(tracker.computeLeakingDisposables()).toBeUndefined()
    } finally {
      setDisposableTracker(null)
    }
  })

  it('delayed container-materialized disposable is excluded after materialization', () => {
    const tracker = new DisposableTracker()
    setDisposableTracker(tracker)
    try {
      class Svc extends Disposable {
        declare readonly _serviceBrand: undefined
        ping = 'pong'
      }
      const ID = createDecorator<Svc>('extensions-test-delayed-leak')
      const services = new ServiceCollection()
      services.set(ID, new SyncDescriptor(Svc, [], true))
      const inst = new InstantiationService(services, true)
      const proxy = inst.invokeFunction((a) => a.get(ID))
      void proxy.ping // force materialization
      expect(tracker.computeLeakingDisposables()).toBeUndefined()
    } finally {
      setDisposableTracker(null)
    }
  })
})
