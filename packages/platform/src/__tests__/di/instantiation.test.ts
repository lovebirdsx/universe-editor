/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/di/
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  createDecorator,
  IInstantiationService,
  ServicesAccessor,
  _util,
} from '../../di/instantiation.js'
import { SyncDescriptor } from '../../di/descriptors.js'
import { ServiceCollection } from '../../di/serviceCollection.js'
import { InstantiationService } from '../../di/instantiationService.js'

// --- service identifiers used in tests ---

interface ILogService {
  _serviceBrand: undefined
  log(msg: string): void
}
const ILogService = createDecorator<ILogService>('logService-test')

interface IDbService {
  _serviceBrand: undefined
  query(): string
}
const IDbService = createDecorator<IDbService>('dbService-test')

// --- service implementations ---

class LogService implements ILogService {
  declare _serviceBrand: undefined
  readonly messages: string[] = []
  log(msg: string) {
    this.messages.push(msg)
  }
}

class DbService implements IDbService {
  declare _serviceBrand: undefined
  constructor(@ILogService private readonly _log: ILogService) {
    this._log.log('DbService created')
  }
  query() {
    return 'data'
  }
}

// --- tests ---

describe('createDecorator', () => {
  it('returns the same identifier for the same serviceId', () => {
    const id1 = createDecorator('same-id-test')
    const id2 = createDecorator('same-id-test')
    expect(id1).toBe(id2)
  })

  it('toString returns the serviceId', () => {
    const id = createDecorator('my-svc')
    expect(id.toString()).toBe('my-svc')
  })

  it('stores dependency metadata on the constructor', () => {
    const deps = _util.getServiceDependencies(DbService)
    expect(deps).toHaveLength(1)
    expect(deps[0]?.id).toBe(ILogService)
    expect(deps[0]?.index).toBe(0)
  })
})

describe('ServiceCollection', () => {
  it('stores and retrieves services', () => {
    const log = new LogService()
    const col = new ServiceCollection([ILogService, log])
    expect(col.get(ILogService)).toBe(log)
  })

  it('reports has() correctly', () => {
    const col = new ServiceCollection()
    expect(col.has(ILogService)).toBe(false)
    col.set(ILogService, new LogService())
    expect(col.has(ILogService)).toBe(true)
  })
})

describe('InstantiationService', () => {
  it('resolves a pre-registered service instance', () => {
    const log = new LogService()
    const services = new ServiceCollection([ILogService, log])
    const di = new InstantiationService(services)

    const result = di.invokeFunction((accessor: ServicesAccessor) => accessor.get(ILogService))
    expect(result).toBe(log)
  })

  it('registers itself as IInstantiationService', () => {
    const di = new InstantiationService()
    const self = di.invokeFunction((a) => a.get(IInstantiationService))
    expect(self).toBe(di)
  })

  it('instantiates a service from SyncDescriptor with DI injection', () => {
    const log = new LogService()
    const services = new ServiceCollection(
      [ILogService, log],
      [IDbService, new SyncDescriptor(DbService)],
    )
    const di = new InstantiationService(services)

    const db = di.invokeFunction((a) => a.get(IDbService))
    expect(db.query()).toBe('data')
    expect(log.messages).toContain('DbService created')
  })

  it('caches service instances — returns same object on repeated access', () => {
    const services = new ServiceCollection([ILogService, new SyncDescriptor(LogService)])
    const di = new InstantiationService(services)

    const first = di.invokeFunction((a) => a.get(ILogService))
    const second = di.invokeFunction((a) => a.get(ILogService))
    expect(first).toBe(second)
  })

  it('createInstance creates an ad-hoc instance with DI injection', () => {
    const log = new LogService()
    const services = new ServiceCollection([ILogService, log])
    const di = new InstantiationService(services)

    const db = di.createInstance(DbService)
    expect(db.query()).toBe('data')
    expect(log.messages).toContain('DbService created')
  })

  it('createChild inherits parent services', () => {
    const log = new LogService()
    const parent = new InstantiationService(new ServiceCollection([ILogService, log]))
    const child = parent.createChild(new ServiceCollection())

    const result = child.invokeFunction((a) => a.get(ILogService))
    expect(result).toBe(log)
  })

  it('child services override parent services', () => {
    const parentLog = new LogService()
    const childLog = new LogService()
    const parent = new InstantiationService(new ServiceCollection([ILogService, parentLog]))
    const child = parent.createChild(new ServiceCollection([ILogService, childLog]))

    const result = child.invokeFunction((a) => a.get(ILogService))
    expect(result).toBe(childLog)
  })

  it('dispose() disposes created service instances', () => {
    let disposed = false
    class DisposableLog implements ILogService {
      declare _serviceBrand: undefined
      log() {}
      dispose() {
        disposed = true
      }
    }

    const services = new ServiceCollection([ILogService, new SyncDescriptor(DisposableLog)])
    const di = new InstantiationService(services)
    di.invokeFunction((a) => a.get(ILogService))
    di.dispose()
    expect(disposed).toBe(true)
  })

  it('throws when accessing service accessor after invocation completes', () => {
    const di = new InstantiationService(new ServiceCollection([ILogService, new LogService()]))
    let capturedAccessor: ServicesAccessor | null = null
    di.invokeFunction((a) => {
      capturedAccessor = a
    })
    expect(() => capturedAccessor!.get(ILogService)).toThrow()
  })
})
